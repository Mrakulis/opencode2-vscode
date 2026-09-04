# agents.md — OpenCode 2 for VS Code

An independent VS Code sidebar GUI client for OpenCode, built natively on the **OpenCode V2 API** (`@opencode-ai/client@beta`).

| Topic | Where |
|---|---|
| User-facing docs | `README.md` |
| Working memory (decisions, gotchas, status) | `MEMORY.md` |
| Knowledge graph (auto-rebuilt on commit) | `graphify-out/graph.html`, `GRAPH_REPORT.md` |

Historical planning docs (`plan.md`, `todo.md`, `AUDIT_AND_PLAN.md`) were removed after full completion — git history has them if ever needed.

## Stack

- Node.js 22, TypeScript 5.x **strict**, esbuild bundling (extension = CJS/node, webview = iife/browser)
- Webview UI: React 19, **first-party theme system** (`--oc2-*` tokens in `webview-src/styles.css`; dark/light + OpenCode-flavored presets via `[data-theme]`) — deliberately NOT VS Code theme variables
- Server connection: `Service.discover()` + our own hidden spawner (`windowsHide`) for auto-start; never `Service.ensure()` (its spawn opens a console window on Windows)

## Commands

```sh
npm install          # install deps
npm run build        # build extension + webview -> dist/, media/webview/
npm run watch        # esbuild watch (both targets)
npm run typecheck    # tsc --noEmit for both tsconfigs
npm test             # unit tests (node:test + tsx)
npm run audit        # rpc-surface consistency + theme token completeness
npm run package      # build + npx @vscode/vsce package -> .vsix
```

Gate = typecheck + tests (+ `npm run audit` for UI/theme changes).

## V2 API rules (critical) — P0, no bypass

- All server I/O lives in the **extension host** (`src/controller.ts`). The webview never makes HTTP calls — it talks postMessage RPC only (`src/protocol.ts` is the single shared contract).
- Connect via `Service.discover()` / `Service.headers()` from `@opencode-ai/client/service`. Auto-start uses our own hidden spawn of `<cli> serve --service`, then polls discovery — do NOT reintroduce `Service.ensure()`.
- Wrap every client call in the adapter module (`src/apiAdapter.ts`) so beta-API churn localizes to one file. Note: several list endpoints return bare arrays while others wrap in `{data}` — the adapter normalizes.
- `/api/event` (SSE) is volatile and lossy by contract: every reconnect must re-sync state from REST endpoints before applying live events. Event routing lives in `webview-src/lib/events.ts`; delta accumulation in `webview-src/lib/deltas.ts`.
- Retries are SERVER-side (`session.retry.scheduled`, `SessionStatus: retry`). Clients observe and offer manual retry only — no client-side backoff.
- Permissions follow OpenCode semantics (`webview-src/lib/permissions.ts`): auto-accept replies `"once"` per session, questions stay interactive, dedupe via RespondedTracker; `"always"` is manual-only.
- **New sessions MUST carry a validated model + canonical directory.** Defaults resolve via `pickNewSessionModel` (`lib/models.ts`; last-used → setting, built-in default `opencode/big-pickle`, catalog-validated with free-Zen fallback). ALL directories sent to the server pass through `canonicalizeDirectory()` (`src/directory.ts`) — a lowercase win32 drive letter crashes the server's instruction initializer and every prompt on that session silently persists nothing (both P0s reproduced live 2026-08-26).

## Layout

- `src/` — extension-host code (`extension.ts`, `controller.ts`, `cli.ts`, `sidebarProvider.ts`, `protocol.ts`, `apiAdapter.ts`, `rpc.ts`, `log.ts`, `notifications.ts`, `autoCompact.ts`, `directory.ts`, `diffDocs.ts` + vscode-free `diffPatch.ts`)
- `webview-src/` — React chat UI (`components/` incl. `SubagentsDrawer`, `PlansDrawer`; `lib/` incl. events/deltas/difftext/slash/permissions/subagents/plans/models helpers)
- `scripts/` — live verification & audit tools (`smoke.mjs` incl. prompt canary, `verify-hidden-start.mjs`, `check-themes.mjs`, `audit-consistency.mjs`, `perm-probe.mjs`)
- `test/` — unit tests (`node --import tsx --test`)
- `media/webview/`, `dist/` — build outputs. **Never edit by hand.**
- `resources/` — icons incl. marketplace assets

## Code style

- TypeScript strict; named exports everywhere (default export only for the extension entry).
- No `any`; use `unknown` + narrowing. No non-null `!` assertions except test fixtures.
- Match surrounding style; prettier owns formatting (`npm run format`).
- Errors: catch specific expected failures; rethrow or surface unexpected ones — no silent catches.

## Scope & budget — anti-runaway, lightweight

- Stay within the user's request. If you need >3 files or cross-cutting (adapter+protocol+webview), state plan and ask once before expanding.
- Read a file before editing it. Prefer minimal diff; don't reformat unrelated code (prettier will handle it).
- Budget: ≤12 tool calls before re-anchoring to the original request; if hit, summarize progress and ask to continue.
- No speculative refactors or "while I'm here" cleanups unless asked.

## Boundaries

**P0 — NEVER (no bypass)**
- Commit API keys or tokens (the graphify LLM key lives in `.env`, gitignored).
- Write to files outside this project folder.
- `E:\_Code\OpenCode2 Mobile Companion Android` is the phone client for our companion server — IS READ ONLY as reference only: never write, edit, rename, or delete anything there.
- Edit generated outputs (`dist/`, `media/webview/`) directly.
- Use `Service.ensure()` — use `Service.discover()` + hidden spawn with `windowsHide`.
- Mix V1 CLI/TUI concepts into the client: the catalog comes from V2 endpoints, and TUI-only events (`tui.*`) are ignored.

**P1 — ASK FIRST (one question, then proceed)**
- Adding any dependency (runtime or dev).
- Changing the settings namespace or public command IDs.
- Pushing without a verified version bump (`package.json` + `CHANGELOG.md` + gate).
- Expanding scope beyond request (>3 files / new feature) or touching `src/protocol.ts` / `src/apiAdapter.ts` contract.

On "ask first": ask once via question/steer, wait for answer, don't loop. If user says "go ahead" / "push now" / "yes, expand scope", that is explicit confirmation for this session.

**P2 — ALWAYS (but bounded)**
- Gate before claiming done: `npm run typecheck`, `npm test`, `npm run build` (+ `npm run audit` for picker/theme/rpc changes). Max 2 auto-fix attempts per failure; on third failure, report output and ask.
- Update `MEMORY.md` on milestones/gotchas only (not every small fix).
- Keep new md files inside the project root only.

## Loop breakers

- If same error/failure repeats twice, stop retrying the same edit — explain and ask.
- Don't retry with client-side backoff; retries are server-side only.
- If blocked by P0/P1 and user explicitly overrides a P1, obey the override for this session and note it in the summary.
- Progress over perfection: don't loop on formatting/style — minimal diff + prettier is enough.

## Definition of done

Typecheck passes → tests pass → build succeeds (+ `npm run audit` where applicable) → feature verified against a live service where feasible → `package.json` version bumped + `CHANGELOG.md` moved from `Unreleased` → versioned entry **only if releasing** → committed with conventional message (`chore(release): vX.Y.Z` or `feat`/`fix` with bump) → `git tag vX.Y.Z && git push origin vX.Y.Z` only after bump is verified — never push on `Unreleased` alone (graphify regenerates via the post-commit hook).
