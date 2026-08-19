# dsh-fullweb

Key-free internet access for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (run as `npx @deepseek-ai/dsh web`):

- **`web_search`** — anonymous DuckDuckGo HTML search with a Bing fallback. No API key, no vendor billing endpoint.
- **`web_fetch`** — public HTTP(S) retrieval with SSRF protection (loopback, private ranges, link-local, and `file://` are blocked; every redirect hop is re-validated), size/char caps, and HTML→markdown handled by dsh itself.
- **"Code + full web" agent preset** (`code-fullweb`) — the shipped `code` preset with `web_fetch` enabled. It installs itself into your preset root (`~/.dsh/.agent-presets/`) on first boot and stays in sync when you update this package (a version stamp marks managed copies).

Everything runs locally through Node's `fetch`. The deployment's own search provider (e.g. DeepSeek) stays registered but is never selected, so no web traffic touches a paid endpoint.

## Requirements

- Node 20+ with npx, and the harness available as `npx @deepseek-ai/dsh` (any launcher: `web`, TUI, headless).
- **pnpm on PATH** (`npm install -g pnpm`) — plugin installs are forwarded to it.

## Install

One command per profile you want web access in (usually just `web` for the browser UI):

```sh
# from npm:
npx @deepseek-ai/dsh --profile web plugin add dsh-fullweb

# or straight from git (no registry needed):
npx @deepseek-ai/dsh --profile web plugin add git+https://github.com/arialp/dsh-fullweb.git#main
```

What happens: pnpm installs the package into your profile, and `dsh` automatically appends it to the profile's bundle stack — its patch layer then selects the local providers on the host `web` row. On the next boot the plugin also copies the shipped preset into `~/.dsh/.agent-presets/code-fullweb/` (idempotent; a `.dsh-fullweb-version` stamp marks it as managed).

To stop the preset from installing at all while keeping the web tools, create an opt-out marker: touch `~/.dsh/.agent-presets/.dsh-fullweb-absent`.

## Enable the preset

The provider side is active for the whole profile immediately. The model-facing tools appear in sessions that run a preset with `web_fetch` enabled:

- **New chats:** Settings → General → agent preset → pick **"Code + full web"**, or make it the default there so every new chat gets both tools.
- Or set it per user document (`~/.dsh/settings.yaml`):

  ```yaml
  agent-presets:
    default: code-fullweb
  ```

Existing sessions keep the preset they were created with; a session that has not produced anything yet can switch presets from its controls.

## Uninstall / update

```sh
npx @deepseek-ai/dsh --profile web plugin remove dsh-fullweb     # or <git spec> if installed from git
npx @deepseek-ai/dsh --profile web plugin update                 # bump to the newest published version
```

`remove` takes the providers and the profile layer out of that profile. The preset copy in `~/.dsh/.agent-presets/` is left behind (it is yours now); delete the directory if you want it gone — while the package is still installed, add `.dsh-fullweb-absent` first so boot does not restore it on the next start. If you had set `code-fullweb` as your default preset, clear that setting (or pick another) before removing.

## Configuration

The provider entry (`id: web-local`) accepts optional config; override it with your own patch layer in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: web-local
  config:
    userAgent: "MyAgent/1.0"     # browser-like UA is the default (engines 403 the Node client)
    fetchTimeoutMs: 45000        # per-request backstop; the tool layer's own budget still applies
    maxRedirects: 5              # redirect hops allowed before WEB_LOCAL_TOO_MANY_REDIRECTS
    downloadCapBytes: 25000000   # stop downloading past this (result is flagged truncated)
    bodyCapChars: 100000         # decoded-body cap handed to the tool layer (truncated flag set)
```

All keys are optional; defaults suit normal web use.

## Notes & limits

- Search scrapes public HTML endpoints, so results are only as good as DuckDuckGo/Bing's anonymous tier and both engines can rate-limit heavy usage (the provider tries Bing automatically when DDG fails).
- The preset is the `code` (Code Mode) preset: it expects a profile that composes a TypeScript runtime (`dsh-web-app` does). Install into other profiles only if they provide one.
- The fetch guard validates the target before connecting and on each redirect, but DNS can still change between check and connect; treat it as a local-tool guardrail, not a security boundary.

## License

MIT — see [LICENSE](./LICENSE).
