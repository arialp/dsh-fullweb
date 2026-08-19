import { createRequire } from "node:module";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { WebError } from "@deepseek-ai/dsh-web";

/**
 * dsh-fullweb profile layer: key-free anonymous web providers for the dsh web
 * seam (`ctx.web`) plus one-time installation of this package's agent preset
 * into the user's preset root.
 *
 * Registers two local providers so workspaces get internet access without any
 * vendor search API: a DuckDuckGo/Bing HTML scraping search provider (id
 * `local-anon`) and a guarded public HTTP(S) fetch provider (id
 * `local-fetch`). A deployment's own search provider stays registered but
 * unselected, so no web traffic touches its billing endpoint.
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "web-local";
/** Services this plugin requires: it registers into the web seam. */
const inject = ["web"];

/** Stable id this search provider registers under (selected in cordis.patch.yml). */
const SEARCH_PROVIDER_ID = "local-anon";
/** Stable id this fetch provider registers under (selected in cordis.patch.yml). */
const FETCH_PROVIDER_ID = "local-fetch";

/** Browser-like UA: both engines 403 the default Node client on HTML endpoints. */
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 dsh-fullweb";

/** Per-engine search request budget; the tool layer's own budget still applies above it. */
const ENGINE_TIMEOUT_MS = 20000;
/** Hard cap on sources one engine parse may yield (the seam enforces maxResults anyway). */
const MAX_SOURCES_PER_ENGINE = 20;

/** Provider config. Every key is optional with a default, so `Config({})` succeeds. */
const Config = z.object({
	userAgent: z.string().min(1).default(DEFAULT_USER_AGENT),
	fetchTimeoutMs: z.number().step(1).min(1000).max(300000).default(45000),
	maxRedirects: z.number().step(1).min(0).max(10).default(5),
	downloadCapBytes: z.number().step(1).min(65536).max(1073741824).default(25000000),
	bodyCapChars: z.number().step(1).min(1000).max(2000000).default(100000)
});

/** Live options; defaults at import time, replaced wholesale by `apply`. */
let options = Config({});

//#region shared http helpers

/** Map one failure of an outgoing request to the seam's error vocabulary. */
function transportError(kind, href, timeoutMs, signal, cause) {
	if (signal?.aborted === true) return new WebError("local web request aborted", "WEB_ABORTED", { cause });
	const message = kind === "timeout" ? `request to ${href} timed out after ${timeoutMs} ms` : `request to ${href} failed: ${String(cause?.message ?? cause)}`;
	return new WebError(message, kind === "timeout" ? "WEB_LOCAL_TIMEOUT" : "WEB_LOCAL_FETCH_FAILED", { cause });
}

/** One GET with a backstop timeout racing the caller's cancellation signal. */
async function httpGet(href, { timeoutMs = ENGINE_TIMEOUT_MS, signal, accept } = {}) {
	const timer = AbortSignal.timeout(timeoutMs);
	const combined = signal !== void 0 ? AbortSignal.any([signal, timer]) : timer;
	try {
		return await fetch(href, {
			redirect: "follow",
			headers: {
				"user-agent": options.userAgent,
				accept,
				"accept-language": "en-US,en;q=0.9"
			},
			signal: combined
		});
	} catch (error) {
		throw transportError(timer.aborted && signal?.aborted !== true ? "timeout" : "network", href, timeoutMs, signal, error);
	}
}

//#endregion
//#region search provider (local-anon)

/** Strip tags and decode the entities that survive in scraped HTML. */
function stripHtml(input) {
	const text = input.replace(/<[^>]*>/gu, "");
	return text
		.replace(/&amp;/giu, "&")
		.replace(/&lt;/giu, "<")
		.replace(/&gt;/giu, ">")
		.replace(/&quot;/giu, '"')
		.replace(/&#39;|&apos;/giu, "'")
		.replace(/&nbsp;/giu, " ")
		.replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
		.replace(/\s+/gu, " ")
		.trim();
}

/** Collapse a snippet to a bounded single line for the source list. */
function clipSnippet(input) {
	if (input.length <= 320) return input;
	const cut = input.slice(0, 320);
	return cut.slice(0, Math.max(cut.lastIndexOf(" "), 0)) + "…";
}

/** Unwrap DuckDuckGo's `/l/?uddg=` redirect wrapper to the real target URL. */
function resolveEngineHref(href) {
	try {
		const url = new URL(href, "https://duckduckgo.com");
		if (url.hostname.endsWith("duckduckgo.com")) {
			const uddg = url.searchParams.get("uddg");
			return uddg !== null && uddg.length > 0 ? uddg : null;
		}
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	} catch {
		return null;
	}
}

/** Parse the DuckDuckGo HTML endpoint (result__a titles, result__snippet bodies). */
function parseDuckDuckGo(html) {
	const snippets = [];
	for (const match of html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gu)) snippets.push(clipSnippet(stripHtml(match[1])));
	const sources = [];
	let index = 0;
	for (const match of html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu)) {
		const url = resolveEngineHref(match[1]);
		if (url === null) continue;
		const title = stripHtml(match[2]);
		const snippet = snippets[index];
		sources.push({
			url,
			...(title.length > 0 ? { title } : {}),
			...(snippet !== void 0 && snippet.length > 0 ? { snippet } : {})
		});
		index += 1;
		if (sources.length >= MAX_SOURCES_PER_ENGINE) break;
	}
	return sources;
}

/** Parse Bing's b_algo result list items. */
function parseBing(html) {
	const sources = [];
	for (const chunk of html.split(/<li[^>]*class="b_algo"/u).slice(1)) {
		const anchor = /<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/iu.exec(chunk);
		if (anchor === null) continue;
		let url;
		try {
			url = new URL(anchor[1]);
		} catch {
			continue;
		}
		if (url.hostname.endsWith("bing.com") || url.hostname.endsWith("microsofttranslator.com")) continue;
		const title = stripHtml(anchor[2]);
		const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/iu.exec(chunk);
		const snippet = paragraph !== null ? clipSnippet(stripHtml(paragraph[1])) : void 0;
		sources.push({
			url: url.href,
			...(title.length > 0 ? { title } : {}),
			...(snippet !== void 0 && snippet.length > 0 ? { snippet } : {})
		});
		if (sources.length >= MAX_SOURCES_PER_ENGINE) break;
	}
	return sources;
}

/** Run one engine behind a timeout, returning parsed sources or the failure. */
async function runEngine(endpoint, href, parse, signal) {
	try {
		const response = await httpGet(href, { signal, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" });
		if (!response.ok) return { error: new WebError(`${endpoint} answered HTTP ${response.status}`, "WEB_LOCAL_HTTP_ERROR") };
		const sources = parse(await response.text());
		return sources.length > 0 ? { sources } : { error: new WebError(`${endpoint} returned no parsable results`, "WEB_LOCAL_PARSE_FAILED") };
	} catch (error) {
		if (signal?.aborted === true) throw error;
		return { error: error instanceof WebError ? error : new WebError(String(error), "WEB_LOCAL_FETCH_FAILED", { cause: error }) };
	}
}

/** Key-free anonymous search: DuckDuckGo HTML first, Bing as the fallback engine. */
const SearchProvider = {
	id: SEARCH_PROVIDER_ID,
	available() {
		return typeof globalThis.fetch === "function";
	},
	async search(request, signal) {
		const query = request?.query;
		if (typeof query !== "string" || query.trim().length === 0) throw new WebError("web_search requires a non-empty query", "WEB_LOCAL_BAD_REQUEST");
		const ddg = await runEngine(
			"DuckDuckGo",
			`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`,
			parseDuckDuckGo,
			signal
		);
		if (ddg.sources !== void 0) return { sources: ddg.sources, truncated: false };
		const bing = await runEngine(
			"Bing",
			`https://www.bing.com/search?q=${encodeURIComponent(query.trim())}&setlang=en&cc=us&mkt=en-US`,
			parseBing,
			signal
		);
		if (bing.sources !== void 0) return { sources: bing.sources, truncated: false };
		throw new WebError(`anonymous search failed via DuckDuckGo (${ddg.error.message}) and Bing (${bing.error.message})`, "WEB_LOCAL_SEARCH_FAILED", { cause: ddg.error });
	}
};

//#endregion
//#region fetch provider (local-fetch)

/** True for addresses that must never be fetched: loopback, private, CGNAT, link-local. */
function isBlockedIp(ip) {
	const version = net.isIP(ip);
	if (version === 4) {
		const parts = ip.split(".").map(Number);
		return (
			parts[0] === 0 ||
			parts[0] === 10 ||
			parts[0] === 127 ||
			(parts[0] === 169 && parts[1] === 254) ||
			(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168) ||
			(parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
		);
	}
	if (version !== 6) return true;
	const lower = ip.toLowerCase();
	if (lower === "::" || lower === "::1") return true;
	const dotted = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u);
	if (dotted !== null) return isBlockedIp(dotted[1]);
	const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
	if (hexMapped !== null) {
		const high = Number.parseInt(hexMapped[1], 16);
		const low = Number.parseInt(hexMapped[2], 16);
		return isBlockedIp(`${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`);
	}
	const first = BigInt(`0x${lower.split(":")[0] || "0"}`);
	return (first & 0xfe00n) === 0xfc00n || (first & 0xffc0n) === 0xfe80n;
}

/** Reject hosts that resolve to anything but public internet addresses. */
async function assertPublicTarget(url, signal) {
	const host = url.hostname.replace(/^\[|\]$/gu, "");
	if (host.length === 0 || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
		throw new WebError(`blocked non-public hostname "${url.hostname}"`, "WEB_LOCAL_URL_BLOCKED");
	}
	let addresses;
	if (net.isIP(host)) addresses = [host];
	else {
		const records = await dns.lookup(host, { all: true });
		addresses = records.map((record) => record.address);
		if (addresses.length === 0) throw new WebError(`hostname "${host}" did not resolve`, "WEB_LOCAL_DNS_FAILED");
	}
	for (const address of addresses) {
		if (isBlockedIp(address)) throw new WebError(`blocked non-public target address ${address} for host "${url.hostname}"`, "WEB_LOCAL_URL_BLOCKED");
	}
	void signal;
}

/** Decode a response body into the seam's closed html/text union, under both caps. */
async function buildResult(response, finalUrl) {
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	let kind;
	if (contentType.includes("text/html")) kind = "html";
	else if (contentType.startsWith("text/") || /json|xml|javascript|x-www-form-urlencoded|yaml|csv/.test(contentType)) kind = "text";
	else if (contentType.length === 0) kind = /\.html?(\?|#|$)/iu.test(new URL(finalUrl).pathname) ? "html" : "text";
	else throw new WebError(`unsupported content-type "${contentType}"`, "WEB_LOCAL_UNSUPPORTED_CONTENT");

	const reader = response.body?.getReader();
	if (reader === void 0 || reader === null) return { url: finalUrl, statusCode: response.status, body: { kind, content: "" }, truncated: false };
	const chunks = [];
	let totalBytes = 0;
	let capped = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		chunks.push(value);
		if (totalBytes > options.downloadCapBytes) {
			capped = true;
			await reader.cancel().catch(() => {});
			break;
		}
	}
	let content = Buffer.concat(chunks).toString("utf8");
	let truncated = capped;
	if (content.length > options.bodyCapChars) {
		content = content.slice(0, options.bodyCapChars);
		truncated = true;
	}
	return { url: finalUrl, statusCode: response.status, body: { kind, content }, truncated };
}

/** Guarded public HTTP(S) retrieval with per-hop SSRF re-validation and a redirect budget. */
const FetchProvider = {
	id: FETCH_PROVIDER_ID,
	available() {
		return typeof globalThis.fetch === "function";
	},
	async fetch(request, signal) {
		let url;
		try {
			url = new URL(String(request?.url ?? ""));
		} catch {
			throw new WebError(`invalid URL: ${JSON.stringify(request?.url ?? null)}`, "WEB_LOCAL_URL_INVALID");
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new WebError(`only http(s) URLs can be fetched, got protocol "${url.protocol}"`, "WEB_LOCAL_URL_INVALID");
		}
		let current = url;
		for (let hops = 0; ; hops += 1) {
			await assertPublicTarget(current, signal);
			const response = await httpGet(current.href, { timeoutMs: options.fetchTimeoutMs, signal, accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.7" });
			if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
				const location = response.headers.get("location");
				await response.body?.cancel().catch(() => {});
				if (location === null) return await buildResult({ status: response.status, headers: new Headers(), body: null }, current.href);
				let next;
				try {
					next = new URL(location, current.href);
				} catch {
					throw new WebError(`redirect to an unparseable location "${location}"`, "WEB_LOCAL_REDIRECT_INVALID");
				}
				if (next.protocol !== "http:" && next.protocol !== "https:") throw new WebError(`redirect left http(s) (protocol "${next.protocol}")`, "WEB_LOCAL_URL_BLOCKED");
				if (hops + 1 > options.maxRedirects) throw new WebError(`too many redirects (limit ${options.maxRedirects}) fetching ${current.href}`, "WEB_LOCAL_TOO_MANY_REDIRECTS");
				current = next;
				continue;
			}
			return await buildResult(response, current.href);
		}
	}
};

//#endregion
//#region preset installation

/** Package manifest, read once from this module's own location. */
const manifest = createRequire(import.meta.url)("../package.json");
/** The agent preset shipped with this package (one directory per preset). */
const PRESET_SOURCE_ROOT = new URL("../preset/", import.meta.url);
/** Preset id this package manages in the user's preset root. */
const MANAGED_PRESET_ID = "code-fullweb";
/** Version stamp written into a managed preset so updates can propagate once. */
const STAMP_FILE = ".dsh-fullweb-version";
/** Opt-out marker: while present, the managed preset is never (re)installed. */
const ABSENT_MARKER = ".dsh-fullweb-absent";

/**
 * Ensure this package's preset lives in the user's preset root
 * (`<dshHome>/.agent-presets`) — the roster always scans that directory, while
 * launcher-level overlays own every other configured root and would discard a
 * bundle-contributed one. Rules:
 * - absent marker present → never touch (the user opted out);
 * - preset already stamped with this version → leave it alone;
 * - present but unstamped or stale → replace with the shipped copy, stamp it.
 */
function ensurePresetInstalled() {
	const dshHome = resolveDshHome();
	const presetRootDir = join(dshHome, ".agent-presets");
	if (existsSync(join(presetRootDir, ABSENT_MARKER))) return;
	const source = new URL(`${MANAGED_PRESET_ID}/`, PRESET_SOURCE_ROOT);
	const target = join(presetRootDir, MANAGED_PRESET_ID);
	const stampPath = join(target, STAMP_FILE);
	const currentStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : void 0;
	if (currentStamp === manifest.version) return;
	mkdirSync(presetRootDir, { recursive: true });
	rmSync(target, { recursive: true, force: true });
	cpSync(source, target, { recursive: true });
	writeFileSync(stampPath, manifest.version);
}

//#endregion
/** Register both providers into the web seam and install the managed preset. */
function apply(ctx, config) {
	options = Config(config ?? {});
	ensurePresetInstalled();
	ctx.web.registerSearchProvider(SearchProvider);
	ctx.web.registerFetchProvider(FetchProvider);
}

export { FETCH_PROVIDER_ID, SEARCH_PROVIDER_ID, SearchProvider, FetchProvider, PRESET_SOURCE_ROOT, STAMP_FILE, ABSENT_MARKER, MANAGED_PRESET_ID, Config, name, inject, apply };
