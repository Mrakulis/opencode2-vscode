# todo.md — progress tracker

Legend: ☐ todo · ◨ in progress · ✅ done · ⏸ blocked/deferred

**Current: ✅ ALL v0.2 MILESTONES COMPLETE** — v0.2.37 (providers/models/MCP/workspace scope) 2026-08-23

---

## Post-audit roadmap — see `AUDIT_AND_PLAN.md`

Full functionality audit complete 2026-08-23. **Open Questions (§5 of that doc) are pending your review/annotation before any code.** Milestones copied from the audit plan:

- [ ] M-theme: own first-party theme tokens (replace `--vscode-*`) + theme switcher; later add official OpenCode themes as presets
- [ ] M5: slash commands + skills + `@` mention (inline `/` popover) — the headline gap
- [ ] M6: real Forms (replace the `isQuestion` text heuristic)
- [ ] M7: event router + true delta streaming + parity (export/import, undo/redo, connect in-app, init, vcs, worktrees, saved perms, queue/steer UI, binary-name fix)
- [ ] M8: polish, richer rendering, README correction, vsix



## M0 — Scaffold ✅
- ✅ plan.md, agents.md, MEMORY.md, todo.md created; git repo initialized
- ✅ graphify installed + post-commit hook wired (see Setup log below)
- ✅ npm project: package.json (`opencode2-vscode`, pinned `@opencode-ai/client@0.0.0-beta-17927`)
- ✅ esbuild.mjs dual-target build (extension CJS/node + webview iife/browser, webview minified)
- ✅ tsconfig.json + tsconfig.webview.json (strict)
- ✅ package.json contributions: activitybar container, webview view, commands, keybinds, `opencode2.*` config schema
- ✅ activity bar icon (resources/opencode.svg)
- ✅ hello-world React webview renders in sidebar (CSP+nonce HTML, density toggle round-trips host⇄webview)
- ✅ typecheck passes → commit `feat(m0): scaffold extension + webview shell`

## M1 — Connection layer ✅
- ✅ src/cli.ts — detect `opencode2`/`opencode`, install command (npm opencode-ai@beta)
- ✅ src/controller.ts — discover → ensure fallback chain, explicit baseUrl override, generation-guarded reconnects
- ✅ src/log.ts — output channel gated by `opencode2.debug.logs`
- ✅ status bar states connected/connecting/error
- ✅ commands live: focus, toggle, refresh, restartService, openTerminal, installCli
- ✅ connection state pushed to webview chip (+ error empty-state)
- ✅ SMOKE-TESTED against real service: discover→health OK (127.0.0.1:49374, v0.0.0-beta-17927)
- ✅ typecheck passes → commit `feat(m1): v2 service connection layer`

## M2 — Chat MVP ✅
- ✅ src/protocol.ts typed RPC contract (rpc envelope + push events) + sidebarProvider bridge
- ✅ src/apiAdapter.ts — ALL client calls isolated (pure, unit-testable)
- ✅ src/rpc.ts host dispatcher w/ defensive param validation
- ✅ controller event pump: subscribe loop + drop detection + backoff reconnect + onResync
- ✅ Session drawer: search, create, select, inline-rename (dbl-click title), delete w/ confirm
- ✅ Feed: user bubbles, assistant md (marked+dompurify), collapsible reasoning, tool cards w/ diff coloring, streaming caret, jump-to-latest
- ✅ Composer: auto-grow, Enter/Shift+Enter, md preview toggle, Send⇄Stop interrupt
- ✅ Live streaming via debounced refetch on session.* events; optimistic user bubble
- ✅ Reconnect resync wired end-to-end
- ✅ SMOKE-TESTED live: create/list/rename/messages/models(473)/agents/events/delete
- ✅ typecheck passes → commit `feat(m2): chat mvp`

## M3 — Agent controls ✅
- ✅ model picker combobox (/api/model) + per-session switch — landed with M2 HeaderBar; now shows real context limits
- ✅ agent picker (/api/agent) + per-session switch (Build/Plan verified live)
- ✅ permission cards inline + reply endpoint (client.permission.reply) + pending-permissions sync on connect/resync
- ✅ cost/token badges + context meter using model limit.context (473 models cached)
- ✅ auto-compact threshold — src/autoCompact.ts, arms per execution run, opencode2.agent.autoCompactThreshold
- ✅ queue-vs-steer delivery param plumbed through prompt.send rpc
- ✅ typecheck passes → commit feat(m3): agent controls


## M4 — Productization polish ✅
- ✅ notifications: agent finished/failed + permission requests, routed around the visible session
- ✅ sounds: subtle WebAudio chimes (no assets), gated by opencode2.ui.sounds
- ✅ accentTint setting (lands with M0/M2 theming)
- ✅ multi-root workspace location handling (focused-editor folder preferred)
- ✅ diff viewer for tool edits (+/- colored); transcript export to clipboard
- ✅ overflow menu (⋯): copy transcript, fork session (boundary through), compact now
- ✅ unit tests: node:test + tsx — 16/16 pass (format helpers + protocol guards)
- ✅ README.md, LICENSE, .vscodeignore, repository field
- ✅ vsce package → opencode2-vscode-0.1.0.vsix (116 KB, 13 files)


---

## Setup log (done before M0)

- ✅ Research: V2 API/client docs + OpenAPI spec extracted (plan.md §1)
- ✅ plan.md moved to project root
- ✅ agents.md / MEMORY.md / todo.md created (project root only)
- ✅ .gitignore (.env, dist/, out/, node_modules/, *.vsix, graphify-out/)
- ✅ GEMINI_API_KEY stored in .env (gitignored)
- ✅ Initial graphify build of the repo → graphify-out/
- ✅ graphify post-commit hook installed and wired to load .env

## Changelog (append at each commit)

- 2026-08-23 · chore(repo): docs scaffold + git init + graphify hook
- 2026-08-23 · chore(graphify): initial knowledge graph built (11 nodes/4 communities, Gemini semantic pass) · post-commit hook patched to load `.env`
- 2026-08-23 · feat(m0): extension + webview scaffold; typecheck+build green (see git log)
- 2026-08-23 · feat(m1): connection layer (cli/controller/log) + status bar + commands; live smoke test OK
- 2026-08-23 · feat(m2): chat mvp (rpc bridge, event pump, drawer, feed, composer)
- 2026-08-23 · feat(m3): real ctx meter, permissions sync, auto-compact watcher
- 2026-08-23 · feat(m4): notifications, chimes, overflow actions, fork, tests (16/16), vsix package
- 2026-08-23 · feat(ui): full per-session token counters
- 2026-08-23 · feat(v0.2): C1 settings envelope · C2 grouped picker + Model Manager (visibility/favorites/default/recents) · C3 display behaviors (reasoning, tool-expand, sendKey, stats gate, errors toasts) · C4 Providers drawer + CLI auth handoff · C5 MCP drawer (full CRUD, live status, runtime-scope notice; persistence smoke-tested) · C6 folder-scoped sessions with all-projects toggle · 29/29 tests · vsix 0.2.0 — drawer rows, status-strip breakdown (↑in ↓out ✻reasoning ⟲cache = total), per-message badges; tests 18/18; vsix repackaged
