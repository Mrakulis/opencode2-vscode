# MEMORY.md — agent working memory

> Read this first in every new session. Update it at every milestone (or when a decision/gotcha appears). Keep it short — pointers + facts that aren't in code.

## Status snapshot

- **Status: v0.2.37 COMPLETE (features)** — all planned v0.2 features shipped & committed 2026-08-23; vsix packaged. **Next:** full functionality audit done (see `AUDIT_AND_PLAN.md`); awaiting review of its Open Questions (§5) before implementing M-theme/M5–M8.
- **Repo:** 14 commits; conventional commits; gates = typecheck + 29/29 tests + build
- **v0.2 additions:** settings envelope (10 new `opencode2.*` keys pushed via ready), grouped model picker w/ favorites/recents/visibility, Model Manager drawer, display behavior prefs, Providers drawer + CLI auth handoff, MCP drawer (full CRUD + live status), folder-scoped sessions with all-projects toggle
- **Verified:** MCP add/list/remove round-trip live; config-file untouched ⇒ runtime-scoped changes (documented in drawer)

## Decisions log (append-only, newest last)

1. Independent product — UX defined by V2 capabilities and VS Code conventions.
2. React webview UI; esbuild dual-target build; TypeScript strict.
3. Branding/settings namespace: `opencode2.*` ("OpenCode 2 for VS Code").
4. Theming: always follow the user's VS Code theme (`--vscode-*` vars); identity via shape/typography only; optional `opencode2.ui.accentTint`; density compact⇄comfortable switchable.
5. All server I/O in extension host; webview is RPC-only over postMessage.
6. Feature-rich but clean UI per plan.md §8; progressive disclosure.
7. Theming pivot (2026-08-23): we are NOT following the VS Code theme. Own design language now; official OpenCode themes added later as presets. `plan.md §9` superseded. Current `styles.css` is `--vscode-*`-based -> needs first-party token rework (see `AUDIT_AND_PLAN.md` M-theme).
8. GUI-first direction (2026-08-23): build a bespoke VS Code GUI sidebar, not a TUI/CLI clone. Slash commands/skills/`@` = native popovers / `FormCard`s; OpenCode desktop app referenced for feature parity + official themes only.
9. Full functionality audit complete (2026-08-23): `AUDIT_AND_PLAN.md` has findings + Open Questions (§5, for inline review) + milestones (M-theme/M5–M8). Headline gap = missing slash commands/skills/`@` mention. Pending user review of §5 before implementation.
10. V1 vs V2 boundary (2026-08-23): implement **V2 ONLY**. The OpenCode V1 desktop app is UX-reference only (how features are *presented*), never a source of API/config/command semantics. Slash-command catalog must come from V2 `command.list()`/`session.command` (+ `skill.list()`); do NOT hardcode V1 TUI command names. The V2 OpenAPI spec + `@opencode-ai/client` types are the only source of truth (see `AUDIT_AND_PLAN.md` V1-vs-V2 boundary note). Ignore V2 `Tui*`/`Installation*` events (they're for the TUI client / CLI self-update).

## Environment facts (Windows box)

- OS win32 · PowerShell (pwsh) shell · paths use `\`
- Node 22.20 / npm 11.14 / TypeScript via npm / Python 3.13.7 / uv 0.12.1 / git 2.51
- graphify CLI 0.9.48 installed globally (pip/uv tool `graphifyy`)
- Graphify LLM key: stored in `.env` at project root as `GEMINI_API_KEY=...` (**gitignored — never commit, never print**)
- Graphify post-commit hook: `.git/hooks/post-commit` runs AST re-extract on committed code files; docs changes need manual `/graphify --update`
- V2 OpenAPI spec cached at `%TEMP%\opencode-v2-openapi.json` (421 KB) — may vanish; re-download from https://opencode.ai/v2/openapi.json

## Gotchas learned

- Plan-mode earlier wrote to `C:\Users\mraku\.opencode\plan\` — user rule now: project files live ONLY inside the project folder.
- User wants visible progress tracking → keep todo.md current at all times, not just milestones.
- `@opencode-ai/client@beta`: pin exact version (`0.0.0-beta-17927`); route ALL calls through apiAdapter so churn is one-file fixes.
- Node 22 `.mjs` cannot contain TS syntax (inline `type` imports) — esbuild.mjs uses JSDoc types instead.
- `@types/react-dom` lags react releases; use `^19.2.0`, don't copy react's exact version.
- Git "dubious ownership" on this filesystem required one-time global `safe.directory` entry for the project path.
- Webview CSP: script-src needs nonce; styles use `${webview.cspSource} 'unsafe-inline'`.
- Client pkg is ESM-only with exports map → extension tsconfig needs `moduleResolution: "bundler"`. All types importable from root `@opencode-ai/client` (deep `dist/` paths blocked by exports map).
- Client object does NOT expose baseUrl — controller tracks it (`activeBaseUrl`).
- V2 CLI binary is `opencode2` locally (v0.0.0-beta-17927); npm `opencode-ai@beta` still names its bin `opencode` — detection tries opencode2 then opencode.
- `Service.discover()` returns undefined when none; both discover/ensure endpoints work with `Service.headers()`.
- Event names are prefixed: `session.execution.*`, NOT `execution.*` — the typed V2Event union catches this at typecheck time. Trust the union, not memory.
- Permission reply is `client.permission.reply({sessionID, requestID, reply})` — top level, NOT under session.
- Session fork requires a boundary (`{type:'through'}` works for full-history fork).
- vsce refuses `"private": true` in package.json when packaging.
- PowerShell mangles unicode checkboxes in md files — edit todo.md via node scripts, not PS string ops.

## Open questions / risks

- Event payload shapes are opaque in the spec → type empirically during M2 against a live service.
- Confirm actual binary name (`opencode2` vs `opencode`) once CLI is detected; make configurable either way.
- Webview CSP will need explicit allowances when we add local fonts/assets.
- Type predicates must target a subtype of the array element type or narrowing silently no-ops (hit in HeaderBar favorites/recentRows).
- MCP add/remove over HTTP is RUNTIME-scoped: config file untouched after mutations (verified). Permanent installs go through opencode.json/CLI; drawer documents this.
- `GET /api/model/default` returns `{location, data: ModelInfo|null}`.
- IntegrationInfo carries methods[] + connections[] — used for auth-status UI in Providers drawer.
- PowerShell mangles unicode checkboxes/backticks in md files — edit via node scripts.

## Session protocol

1. Read agents.md → MEMORY.md → todo.md before working.
2. Do work for the current milestone only unless told otherwise.
3. Typecheck → update todo.md/MEMORY.md → commit (conventional message).
4. On milestone commit: verify graphify-out/ refreshed.
