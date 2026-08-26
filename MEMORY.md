# MEMORY.md — agent working memory

> Read this first in every new session. Living facts only — history lives in git.

## Status

- **v0.6.7 (2026-08-26)** — steer/queue fix (composer submit hard-blocked on busy; busy sends now default steer / queue when toggled; server verified live). Previous:  — P0 fix ("new sessions unusable": fresh sessions had no model binding → server default blocked by provider data-policy → every prompt failed silently) + full seven-module batch: catalog-validated defaults (opencode2.models.default now **opencode/big-pickle**, free Zen) w/ free-Zen fallback (`pickNewSessionModel`), smart-retry model repair, execution-failure notice banner, prompt-aware smoke canary, native pre-apply diff review (`permission.asked.metadata.files[]` = FileDiff.Info, `src/diffPatch.ts` applier + `opencode-diff:` provider), CodeMode execute-tool visualizer + per-server codemode toggle (McpDrawer via config.get + runtime mcp.add), subagent inspector (child sessions via parentID — no subagent.* events exist), bespoke plan checklist (lib/plans.ts), reconnect banner w/ restart + last-session restore, own-mode health-probe fall-through. Client re-pinned to **beta-18230** matching the live server (interrupt returns payload; session.command requires text; event union: -integration.connection.updated, +credential.*, project.updated, persistent-pty.*).
- **Gates:** typecheck · 124 unit tests · build · npm run audit (theme/rpc surface) · live smoke incl. prompt canary
- **v0.3.37 (2026-08-25)** — full V2 GUI parity shipped. Docs consolidated: `plan.md`/`todo.md`/`AUDIT_AND_PLAN.md` deleted after completion (git history retains them). Living docs = this file + `agents.md` + `README.md`.
- **Support policy:** end users run their own CLI at whatever version they have — version skew is inherent. CI carries a non-blocking **beta-drift canary** (floating `@beta` install + gates) to catch upstream breakage early; the adapter's defensive normalization is the compatibility layer.
- **Version note:** v0.4.0 (2026-08-25) — docs consolidation + client re-pin.

## Current architecture facts

- **V2 only.** V1 desktop/TUI is UX-reference, never a source of API semantics. Ignore V2 `tui.*`/`installation.*` events. Slash catalog comes from V2 `command.list()`/`skill.list()`; never hardcode V1 TUI names.
- **GUI-first:** bespoke sidebar, not a terminal clone. Slash/skills/`@` = popovers; forms = `FormCard`; provider limits = action cards with links (`url.open` rpc).
- All server I/O in the extension host; webview is RPC-only over postMessage (`protocol.ts`). Every client call wrapped in `apiAdapter.ts`.
- Auto-start spawns `<cli> serve --service` ourselves (`detached` + `windowsHide` + `stdio:"ignore"`, unref'd) then polls `Service.discover()` ≤15s — NEVER `Service.ensure()` (its hard-coded spawn opens a console window on Windows).
- Event routing: explicit table in `webview-src/lib/events.ts` (drift-guarded against the installed SDK's V2Event union; `session.usage.recorded` existed in beta-18050 types but never its union, and is gone entirely in beta-18230 — keep unrouted; `.updated` drives session refetches; catalog drift events tick pickers). Delta streaming: `webview-src/lib/deltas.ts` (text/reasoning/tool deltas keyed by `assistantMessageID` + `ordinal`; tool progress appends into the matching tool card). REST re-sync remains the safety net; `refreshMessages` overlays longer local text/reasoning AND streamed tool output onto lagging snapshots.
- Feed autoscroll: bottom-first pin check (≤1px from max ⇒ pinned), directional unpin (>24px up, or 2% of feed), ResizeObserver on the content wrapper glued via rAF-coalesced floored scrollToBottom, `overflow-anchor:none`. New prompts force-jump and re-pin.
- Retries are SERVER-side (`session.retry.scheduled`, `SessionStatus: retry`, message.retry). UI: retry affordance lives INLINE on the failed assistant message (`Feed` + `assistantFailed()` in `lib/failure.ts` — finish:"error" / error obj / persisted retry marker), shown only while it's the newest message so it scrolls away naturally. `lib/rpc.ts` can't be imported in node tests (acquireVsCodeApi at module load) — keep testable helpers out of it. No client backoff.
- Permissions port upstream session auto-accept (`lib/permissions.ts`): auto-allow replies `"once"` per-session, questions stay interactive, `RespondedTracker` dedupes (1h TTL/1000 cap, cleared on reply failure), drain pending on enable. `"always"` persists rules but is manual-only. Server allow/deny config rules always win.
- Shell/terminal output capped ~8 lines (internally scrollable; `fullShellOutput` overrides). Diff button opens VS Code side-by-side (HEAD↔worktree); inline preview capped too.
- share/unshare: no V2 API endpoints — permanently N/A.

## Gotchas

- Client pinned exact (`@opencode-ai/client@beta-18230` since v0.6.6 — matches live server); route all calls through `apiAdapter.ts`.
- Several list endpoints return BARE arrays (`form.list`, `session.export/import`, `inbox.list`, `permission.saved.list`, `worktree.list`) while others wrap `{data}` - adapter normalizes both shapes. **`agent.list`/`model.list` too** (v0.5.5): they 401-crashed pickers on bare-array servers - always route list calls through `asRows()`.
- Context % must come ONLY from assistant-step tokens via `liveContextStepTokens()` (`lib/format.ts`) - session-level `session.tokens` are CUMULATIVE lifetime usage (verified: 15M input/564M cache-read on one session) and survive compaction; compaction leaves a token-less `synthetic` marker, so steps at/before it are ignored and the meter honestly hides until a post-compact step lands. v0.5.5 briefly preferred session tokens - pegged the bar at 100%.
- **New-session model binding (P0 lesson):** never let fresh sessions run without an explicit model — a server default can be blocked by provider data-policy (OpenRouter privacy settings fail with `provider.invalid-request`). Defaults resolve via `pickNewSessionModel` (catalog-validated; free-Zen fallback). Edit permissions carry proposed diffs in `metadata.files[]`; CodeMode = per-server flag + one `execute` tool; subagents = child sessions (`parentID`), NOT events.
- **Drive-letter case (P0 lesson #2, win32):** a session location with a LOWERCASE drive letter (`e:\…`) crashes the server's instruction initializer ("Maximum call stack size exceeded" → `Instructions.InitializationBlocked`) — every prompt on that session silently persists nothing. VS Code can report workspace folders lowercase, so ALL directories sent to the server go through `canonicalizeDirectory()` (`src/directory.ts`; anchored on the COLON after the drive letter — `path.normalize("e:/x")` → `e:\x`, colon at index 1). Move-to-same-path-different-case is a no-op: poisoned sessions are unrecoverable, only prevention works.
- **The client unwraps `{data}` itself** for single-resource endpoints (create/get verified live) - raw-HTTP wraps never reach the adapter; do NOT add unwrap layers. List endpoints still need `asRows` (bare arrays on some servers). New sessions: agent always "build"; model = last-used (`ui.lastModel` RPCs persisted in workspaceState) -> setting -> serverDefault. Webview has NO toast system - failures must surface via the App `notice` banner (silent catches were the new-session bug).
- Local services register with basic auth: discovery supplies creds via `Service.headers(endpoint)`, and explicit loopback `server.baseUrl` URLs now reuse a matching registration's auth (v0.5.5). Remote explicit URLs stay credential-free by design. Default serve port is 4096.
- Tool file parts are `{type:"file", uri, mime, name?}`; delta events key messages by `assistantMessageID` (+`ordinal`).
- V2 CLI binary is `opencode2` locally; npm `opencode-ai@beta` names its bin `opencode` - resolve dynamically, never hardcode. POSIX fallback locations (beyond PATH): `~/.local/bin`, `~/.npm-global/bin`, `~/.opencode/bin`, `~/bin`, `/usr/local/bin`, `/usr/bin` (`src/locations.ts`, platform-injectable + unit-tested) - GUI-launched editors don't inherit shell-profile PATH exports.
- **Flatpak (Linux):** VS Code as Flatpak sandboxes the extension host — host binaries/PATH/fs are invisible. We detect via `FLATPAK_ID` / `/.flatpak-info` / mountinfo (`src/flatpak.ts`, vscode-free for unit tests) and route every CLI action through `flatpak-spawn --host` (`spawnArgvHost` in `src/cli.ts`). CLI must be installed on the HOST. `whereAll` is cross-platform now (`where.exe` on win32, `sh -lc command -v -a` on POSIX, host-escaped on Flatpak) — no more Windows-only `where.exe` everywhere.
- **Flatpak XDG_STATE_HOME redirect:** the sandbox overrides it to `$HOME/.var/app/$ID/state` (≥1.13) while a HOST-spawned service registers at real `~/.local/state` — so `Service.discover()`'s default path NEVER sees the registration. Never call bare `Service.discover()`; use `controller.discoverService()` which probes `registrationFiles()` (`src/flatpak.ts`): `HOST_XDG_STATE_HOME` → canonical `~/.local/state` → env-based. Verified via lib source + flatpak-run(1).
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
