# MEMORY.md — agent working memory

> Read this first in every new session. Living facts only — history lives in git.

## Status

- **v0.3.37 (2026-08-25)** — full V2 GUI parity shipped. Docs consolidated: `plan.md`/`todo.md`/`AUDIT_AND_PLAN.md` deleted after completion (git history retains them). Living docs = this file + `agents.md` + `README.md`.
- **Gates:** typecheck · 65/65 unit tests · build · `npm run audit` · live smoke (`scripts/smoke.mjs`)
- **Maintenance:** client re-pinned to `@opencode-ai/client@beta-18050` in v0.4.0, matching the live server (typecheck + 65 tests + full smoke green against it). Future server betas: bump the pin deliberately and re-run gates + `scripts/smoke.mjs`. `vsce` not on PATH → `npx --yes @vscode/vsce package`.
- **Support policy:** end users run their own CLI at whatever version they have — version skew is inherent. CI carries a non-blocking **beta-drift canary** (floating `@beta` install + gates) to catch upstream breakage early; the adapter's defensive normalization is the compatibility layer.
- **Version note:** v0.4.0 (2026-08-25) — docs consolidation + client re-pin.

## Current architecture facts

- **V2 only.** V1 desktop/TUI is UX-reference, never a source of API semantics. Ignore V2 `tui.*`/`installation.*` events. Slash catalog comes from V2 `command.list()`/`skill.list()`; never hardcode V1 TUI names.
- **GUI-first:** bespoke sidebar, not a terminal clone. Slash/skills/`@` = popovers; forms = `FormCard`; provider limits = action cards with links (`url.open` rpc).
- All server I/O in the extension host; webview is RPC-only over postMessage (`protocol.ts`). Every client call wrapped in `apiAdapter.ts`.
- Auto-start spawns `<cli> serve --service` ourselves (`detached` + `windowsHide` + `stdio:"ignore"`, unref'd) then polls `Service.discover()` ≤15s — NEVER `Service.ensure()` (its hard-coded spawn opens a console window on Windows).
- Event routing: explicit table in `webview-src/lib/events.ts`. Delta streaming: `webview-src/lib/deltas.ts` (text/reasoning/tool deltas keyed by `assistantMessageID` + `ordinal`; tool progress appends into the matching tool card). REST re-sync remains the safety net; `refreshMessages` overlays longer local text/reasoning AND streamed tool output onto lagging snapshots.
- Feed autoscroll: bottom-first pin check (≤1px from max ⇒ pinned), directional unpin (>24px up, or 2% of feed), ResizeObserver on the content wrapper glued via rAF-coalesced floored scrollToBottom, `overflow-anchor:none`. New prompts force-jump and re-pin.
- Retries are SERVER-side (`session.retry.scheduled`, `SessionStatus: retry`, message.retry). UI shows the pill; our Retry chip is manual-only fallback. No client backoff.
- Permissions port upstream session auto-accept (`lib/permissions.ts`): auto-allow replies `"once"` per-session, questions stay interactive, `RespondedTracker` dedupes (1h TTL/1000 cap, cleared on reply failure), drain pending on enable. `"always"` persists rules but is manual-only. Server allow/deny config rules always win.
- Shell/terminal output capped ~8 lines (internally scrollable; `fullShellOutput` overrides). Diff button opens VS Code side-by-side (HEAD↔worktree); inline preview capped too.
- share/unshare: no V2 API endpoints — permanently N/A.

## Gotchas

- Client pinned exact (`@opencode-ai/client@beta-18050` since v0.4.0 — matches live server); route all calls through `apiAdapter.ts`.
- Several list endpoints return BARE arrays (`form.list`, `session.export/import`, `inbox.list`, `permission.saved.list`, `worktree.list`) while others wrap `{data}` — adapter normalizes both shapes.
- Tool file parts are `{type:"file", uri, mime, name?}`; delta events key messages by `assistantMessageID` (+`ordinal`).
- V2 CLI binary is `opencode2` locally; npm `opencode-ai@beta` names its bin `opencode` - resolve dynamically, never hardcode. POSIX fallback locations (beyond PATH): `~/.local/bin`, `~/.npm-global/bin`, `~/.opencode/bin`, `~/bin`, `/usr/local/bin`, `/usr/bin` (`src/locations.ts`, platform-injectable + unit-tested) - GUI-launched editors don't inherit shell-profile PATH exports.
- **Flatpak (Linux):** VS Code as Flatpak sandboxes the extension host — host binaries/PATH/fs are invisible. We detect via `FLATPAK_ID` / `/.flatpak-info` / mountinfo (`src/flatpak.ts`, vscode-free for unit tests) and route every CLI action through `flatpak-spawn --host` (`spawnArgvHost` in `src/cli.ts`). CLI must be installed on the HOST. `whereAll` is cross-platform now (`where.exe` on win32, `sh -lc command -v -a` on POSIX, host-escaped on Flatpak) — no more Windows-only `where.exe` everywhere.
- Permission reply is `client.permission.reply({sessionID, requestID, reply})` — top level, not under session. Fork needs a boundary (`{type:'through'}`).
- Client object does NOT expose baseUrl — controller tracks it. Client pkg is ESM-only with exports map → tsconfig needs `moduleResolution: "bundler"`.
- Webview CSP: nonce for scripts; `${webview.cspSource} 'unsafe-inline'` for styles.
- MCP add/remove over HTTP is runtime-scoped (config file untouched); credentials via `credential.update({credentialID,label})` + integration connect flows.
- Type predicates must target a subtype or narrowing silently no-ops.
- `.mjs` files cannot contain TS syntax; PowerShell mangles unicode in md files — use node scripts/edit tooling.
- vsce refuses `"private": true` in package.json.

## Environment (Windows box)

- win32 · pwsh · Node 22.20 / npm 11.14 · git 2.51
- graphify CLI 0.9.48; post-commit hook rebuilds graph on code commits (docs-only commits skip)
- Graphify LLM key in `.env` as `GEMINI_API_KEY=...` (**gitignored — never commit/print**)
- V2 OpenAPI spec cached at `%TEMP%\opencode-v2-openapi.json` (re-download from https://opencode.ai/v2/openapi.json if missing)

## Session protocol

1. Read `agents.md` → this file before working.
2. Gate every change: `npm run typecheck` → `npm test` → `npm run build` (+ live smoke where feasible).
3. Update this file when a durable fact/decision appears; keep it consolidated, not append-only.
4. Conventional commit → push → verify `graphify-out/` refreshed on code commits.
