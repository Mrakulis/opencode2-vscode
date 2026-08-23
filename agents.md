# agents.md — OpenCode 2 for VS Code

An independent VS Code sidebar client for OpenCode, built natively on the **OpenCode V2 API** (`@opencode-ai/client@beta`).

| Topic | Where |
|---|---|
| Product plan / architecture / UI spec | `plan.md` |
| Working memory (decisions, gotchas, status) | `MEMORY.md` |
| Progress tracker | `todo.md` |
| Knowledge graph (auto-rebuilt on commit) | `graphify-out/graph.html`, `GRAPH_REPORT.md` |

## Stack

- Node.js 22, TypeScript 5.x **strict**, esbuild bundling (extension = CJS/node, webview = iife/browser)
- Webview UI: React 19 (no CSS framework — hand-rolled design tokens over `--vscode-*` variables)
- Server connection: `@opencode-ai/client@beta` (pinned exact version) + `@opencode-ai/client/service`

## Commands

```sh
npm install          # install deps
npm run build        # build extension + webview -> dist/, media/webview/
npm run watch        # esbuild watch (both targets)
npm run typecheck    # tsc --noEmit for both tsconfigs — run before claiming done
npm run package      # vsce package -> .vsix
```

There is no test suite until M4; `npm run typecheck` is the gate.

## V2 API rules (critical)

- All server I/O lives in the **extension host** (`src/controller.ts`). The webview never makes HTTP calls — it talks postMessage RPC only (`src/protocol.ts` is the single shared contract).
- Connect via `Service.ensure()` / `Service.discover()` from `@opencode-ai/client/service`. **Never** spawn `opencode serve` manually or hardcode ports/URLs as the primary path.
- Wrap every client call in the adapter module (`src/apiAdapter.ts`) so beta-API churn localizes to one file.
- `/api/event` (SSE) is volatile and lossy by contract: every reconnect must re-sync state from REST endpoints before applying live events.
- Keep `types/events.ts` as our own event payload types — the OpenAPI spec types events as opaque JSON.

## Layout

- `src/` — extension-host code (`extension.ts`, `controller.ts`, `cli.ts`, `sidebarProvider.ts`, `protocol.ts`, `apiAdapter.ts`)
- `webview-src/` — React chat UI (`components/`, `hooks/`)
- `media/webview/`, `dist/` — build outputs. **Never edit by hand.**
- `resources/` — icons and static assets

## Code style

- TypeScript strict; named exports everywhere (default export only for the extension entry).
- No `any`; use `unknown` + narrowing. No non-null `!` assertions except test fixtures.
- Match surrounding style; prettier owns formatting (`npm run format`).
- Errors: catch specific expected failures; rethrow or surface unexpected ones — no silent catches.

## Git conventions

- Conventional commits: `feat(scope): ...`, `fix(scope): ...`, `chore: ...`
- One commit per milestone minimum; include todo.md + MEMORY.md updates in the milestone commit.
- Never commit: secrets, `.env`, `node_modules/`, `dist/`, `out/`, `*.vsix`.

## Boundaries

**Always**
- Run `npm run typecheck` before declaring any code task done.
- Update `todo.md` checkboxes and `MEMORY.md` status when finishing a milestone.
- Keep new md files inside the project root only.

**Ask first**
- Adding any dependency (runtime or dev).
- Changing the settings namespace or public command IDs.
- Modifying `plan.md` architecture decisions.

**Never**
- Commit API keys or tokens (the graphify LLM key lives in `.env`, gitignored).
- Write to files outside this project folder.
- Edit generated outputs (`dist/`, `media/webview/`) directly.

## Definition of done

Typecheck passes → feature matches `plan.md` intent → todo.md updated → committed with conventional message → graphify regenerates via the post-commit hook (verify `graphify-out/` refreshed on milestone commits).
