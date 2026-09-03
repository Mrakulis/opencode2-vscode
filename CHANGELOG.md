# Changelog

All notable changes to **OpenCode 2 for VS Code** (`opencode2-vscode-gui`) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/). Dates are UTC.

## [Unreleased]

- _No unreleased changes yet._

---

## [0.6.47] - 2026-09-03

### Removed
- **Dead code sweep** — question-capability plumbing with zero callers (`controller.detectQuestionSupport`, `questionsSupported` state/getter, capability emitter, `getServiceTarget`, `questionList`/`questionReply` adapter methods, both RPC handlers, `protocol.ts` method + UI field); dead `Api`/`WireEvent`/`toWireEvent`, `setDaemonStarter`, stale re-exports (`extensionServer`, `diffDocs`, `Composer.SlashEntry`), dead `ModelOption`/`AgentOption` interfaces, and two unused model imports in `App.tsx`. No test removals — nothing under test covered the deleted code.

---

## [0.6.46] - 2026-09-02

### Changed
- **Questions are plain text again — interactive forms removed** — the agent `question` tool renders as static text with options lettered a)/b)/c) (no buttons, no "Other…" row). Every stuck state lived in machinery promising an interactive round-trip the backend can't complete (wedged busy, inbox-trapped or voided answers); text in/out cannot wedge. Removed: `QuestionCard`/`OtherRow`, `answerQuestion`, the answered overlay, and the `hasOpenQuestion` busy carve-out (the interrupt-once `handedBackIds` guard stays), plus dead `.q-*` CSS. Kept: park→interrupt unpark (real servers hang on parked tools), send-time `sessions.active` delivery truth in `sendMessage` (steer when running, plain when idle), and the stale-busy watchdog (`isParked`/`isTerminal` + `parseQuestionInput` helpers, tested).

### Fixed
- **Plain prompt into a live run queued behind it** — `sendMessage` now decides steer-vs-plain from fresh server truth instead of the lossy local busy flag; a stale-false flag no longer files replies into the inbox (visible queue, only delivered after pressing Stop).

---

## [0.6.39] - 2026-09-01

### Added
- **Companion server (extension-owned)** — stable `http://IP:port` with own Basic auth (`opencode2.server.listenEnabled/hostname/port/username/password/cors`). The extension is now the server of record: `src/extensionServer.ts` creates a `http.Server`, validates `Basic` via `timingSafeEqual` (static password), applies CORS, and proxies chunked `text/event-stream` (`GET /api/event`) to the local daemon via `Service.discover()` + `Service.headers()` (HTTP+SSE reliable route, no polling). Remote clients (mobile companion, Tailscale, browser) use one deterministic URL. `POST /opencode2/extension/start` triggers `controller.restart({force:true})` so a phone can start the daemon from `502`. `0.0.0.0` without a password is refused. Commands `Start Companion Server` (top-menu `$(vm-connect)` → opens `opencode2.server.listen` settings), `Show Extension Server URL`, `Restart Extension Server`.
- **Usage date range** — `session.stats` now accepts `from`/`to`/`timezone` (epoch ms + IANA) with `range` echo (`src/apiAdapter.ts`, `src/protocol.ts:SessionStats.range`, `src/rpc.ts:optNum`), backing the Usage drawer range filter.

### Changed
- `ExtensionServer` lifecycle wired in `src/extension.ts` (`start()` after `controller.connect()`, `onDidChangeConfiguration(server.listen)` restart, first window wins on `EADDRINUSE`).

---

## [0.6.40] - 2026-09-01

### Fixed
- **Companion server entry moved to `⋯` dropdown** — `Start Companion Server` no longer a top-bar `$(vm-connect)` icon (`package.json:view/title`), now lives in the header `⋯` menu (`webview-src/components/HeaderBar.tsx` `Companion server…` between `MCP servers…` and `Saved permissions…`, `webview-src/App.tsx` `onOpenCompanion` → `settings.open` `opencode2.server.listen`). `src/rpc.ts:settings.open` now accepts optional `query` param for filtered settings. Reserved slot for app Play Store link.

---

## [0.6.41] - 2026-09-01

### Changed
- **Companion server default port now `12421`** — `opencode2.server.listenPort` default `4096` → `12421` (`package.json`, `src/extensionServer.ts:readListenConfig`). Avoids collision with daemon's default `4096`.

---

## [0.6.42] - 2026-09-01

### Added
- **Companion server drawer inside the extension** — no VS Code Settings. `⋯` → `Companion server…` now opens a dedicated drawer (`webview-src/components/CompanionDrawer.tsx`) with Enable toggle, `hostname`/`port`/`username`/`password`/`CORS`, live `● URL` + Copy/Restart, and app-link placeholder. Backed by `companion.status/update/restart` RPC (`src/protocol.ts`, `src/rpc.ts:readListenConfig` + `companion.*` handlers, `src/extension.ts` wiring). Auth is static `timingSafeEqual` + `0.0.0.0` guard, `HTTP+SSE` `proxyRes.pipe(res)` streaming.

---

## [0.6.43] - 2026-09-01

### Fixed
- **Companion drawer polish** — `▶ Start` / `■ Stop` buttons (not checkbox), `Save settings` now clearly saves all bind/auth fields (`hostname`/`port`/`username`/`password` + advanced CORS), and `CORS` moved to `<details> Advanced` (browser-only). Fixes `not a registered configuration` reload hint (`src/rpc.ts:companion.update`).

## [0.6.44] - 2026-09-01

### Fixed
- **Companion server hardening** — (1) `ExtensionServer.start/stop` now serialize through a lifecycle promise chain: drawer `companion.update` called `start()` directly while the same config writes fired `syncExtensionServer()`, racing into double server creation and spurious `EADDRINUSE` warnings. (2) Non-allow-listed `Origin` on non-preflight requests gets `403` before proxying — browser "simple requests" skip preflight and CORS only blocks *reading*, so daemon auth injected server-side made a loopback no-password server drive-by executable (native apps send no Origin, unaffected). (3) Request handler wrapped in try/catch → `500` instead of unhandled rejection + hanging socket. (4) Client aborts (`res.close` before response end / `req.error`) destroy the upstream request — aborted SSE clients no longer leak daemon sockets. (5) `POST /opencode2/extension/start` returns the reachable companion URL as `url` plus the daemon endpoint as informational `daemon` (was the daemon loopback URL the remote caller couldn't reach). (6) `server.listen*` config changes no longer trigger a full daemon `connect()` (`src/extension.ts`).
- **Non-Error failures surface real messages** — new `errorMessage()` helper (`webview-src/lib/failure.ts`) reads `.message`/`.error`/JSON off thrown non-Errors (mirrored host-side in the `src/rpc.ts` handle catch, 2000-char cap); adopted in composer send + image-attachment paths (`App.tsx`, `Composer.tsx` — a failed attachment placeholder is now removed instead of silently kept). Pure listen-server helpers moved to vscode-free `src/listenConfig.ts` so node tests can import them.

## [0.6.45] - 2026-09-02

### Added
- **Interactive question forms — one form per question** — the question tool renders clickable option buttons plus a free-text "Other…" row again (replacing the v0.6.24 plain-text renderer; the old batch "Continue (X/Y)" machinery stays retired). Because no published OpenCode server ships question-reply routes, the app now **hands the turn back when a question arrives**: it fires the same interrupt as ■ Stop (once per question tool call, ref-guarded), so every answer is sent as a REAL chat message that starts a new turn — never parked as a steer/queue that waits forever. The UI un-busies immediately while a question is open (`busy = busySessions && !hasOpenQuestion`); if a run is already active again, answers go as steer (`sendMessage` delivery fallback on `busySessionsRef`), and an explicit queue toggle still wins. Clicked answers lock with `✓ answered: …`; the answered record is App-owned state keyed by session→toolCallId, so server refetches (which replace tool parts wholesale) can never reopen a form. Streaming tool input (raw JSON string) now parses via the new `webview-src/lib/questions.ts` (+ tests); `.q-*` CSS restored.

### Fixed
- **`server.listen*` config trigger was dead (0.6.44 correction)** — `affectsConfiguration("opencode2.server.listen")` never matches (VS Code aligns sections at key-segment boundaries; the real keys are `listenEnabled` etc.), so the 0.6.44 narrowing was behaviorally a no-op: companion settings changes still forced a full daemon reconnect and Settings-UI toggles never started the server. Now matched explicitly over the six keys (`src/extension.ts`).
- **Companion server `Host` header validation (security)** — missing `Host` → `400`; loopback binds require a loopback host part → `403`. Closes the DNS-rebinding hole a rebound request arrives with no `Origin` header, which the 0.6.44 Origin gate alone misses; the rebound proxy would have injected daemon auth server-side. `parseHostHeader()` lives in vscode-free `src/listenConfig.ts` (+ tests).
- **Single-notify listen errors** — the permanent `server.on("error")` attaches only after a successful listen; a failed bind reports exactly once (was: warning toast + command rejection from a lingering `once("error", reject)`).
- **Atomic `companion.update`** — all params validated/coerced before any config write; a late failure no longer leaves settings half-updated.
- **Usage drawer** — removed the `next!` non-null assertion (AGENTS.md rule) and added a stale-response guard (`loadSeqRef`) so rapid scope switches can't render another scope's numbers.
- Companion drawer "copy URL" surfaces a failure notice instead of a silent `catch {}`; stale `Service.ensure` comment in `controller.ts` corrected to the actual hidden-spawn behavior.

---

## [0.6.38] - 2026-08-31

### Fixed
- **Silent background service start on Windows** — spawning `serve --service` no longer flashes a console window. `src/cli.ts` now prefers sibling `.exe` / direct `node <js>` over `cmd.exe /c` shim, parsing the npm `.cmd` shim when needed; fallback uses `cmd.exe /d /s /c` with quoted command. `src/controller.ts` `startHiddenService` normalizes to `/d /s /c` + `shell:false` + `windowsHide:true` (`CREATE_NO_WINDOW`). `src/locations.ts` expanded well-known Windows probes (`%APPDATA%\npm\<name>.exe`, `<name>.cmd`, `node_modules/@opencode-ai/cli/bin` + `opencode-ai/bin` exe + extensionless). `scripts/verify-hidden-start.mjs` now exercises both exe and shim paths.
- **Model Manager drawer — hide/show and dropdown theme** — `ModelManager.tsx:62` `all/hidden/visible` `<select>` now themed via `.filter-select` (`webview-src/styles.css:630`) matching `--oc2-*` tokens (like `input.search`/`selector`); provider `hide all/show all` now evaluates the full provider model list instead of the filtered slice (`webview-src/components/ModelManager.tsx:102`), fixing label + toggle when the visibility filter is active.

### Changed
- README version pin updated `beta-18230` → `beta-18314`; `server.autoStart` default corrected to `false` (opt-in since v0.6.35); `ui.accentTint` default corrected to `""`; Getting Started / Features note `Start opencode2` CTA when `autoStart` is off.
- `agents.md` boundaries hardened — P0 NEVER, P1 ASK FIRST, P2 ALWAYS (bounded), loop breakers and definition of done with version-bump gate.

---

## [0.6.37] - 2026-08-29

### Added
- **Inbox TUI parity**: `✎ edit` on queued items re-queues via `inbox.cancel` + `composerPrefill`; `payload.files[]` shown as `📎` chip in drawer (`InboxDrawer.tsx:36`, `App.tsx:706`, `Feed.tsx:66`) and ghost text; header micro `steer · queue` + `chip on` badge when `steer`.

### Fixed
- `busyId` disables chips during inbox actions; `inbox-actions` class replaces inline `rowdel` hack (`styles.css:1494`).
- Fallback poll: drawer `3s` interval + `App.tsx:1218` busy poll for `refreshQueued` alongside `refreshMessages` (was event-only, stalled on SSE drop).

## [0.6.36] - 2026-08-28

### Fixed
- **Subagent tail** pinned newest-at-bottom (`SubagentsDrawer.tsx:40` `tailRef` `scrollTop = scrollHeight`).
- **Bottom strip grouped + ephemeral** (TUI-like): `App.tsx:177` groups `childSubs` by agent (`🤖 general ×3`), cap 3 groups + `+N more`, `hasActiveSubagents` via `isSubagentActive`; hidden when 0, `⚡ active/total` pulsing, `0/N` grace 4s then auto-hide.
- **Dot class**: `dot ok busy` → `dot busy` (`SubagentsDrawer.tsx:125`, `styles.css:1890` pulse).

## [0.6.35] - 2026-08-28

### Changed
- **Auto-start now opt-in** — `opencode2.server.autoStart` default `false` (`package.json:224`, `controller.ts:399`). `connect`/`restart`/`cli.start` accept `force:true` so *Restart Background Service* / Start CTA always spawns even when autoStart off; `scheduleRetry` respects `force`; extend shim resolution (`src/locations.ts:24` adds `%APPDATA%\npm\{name}.cmd`); `startHiddenService` pipes stderr + `windowsHide` + exit-code check; `waitForDiscovery` 15s→30s; `connectTimeout` 20s→35s; drop redundant `isHealthy` double-probe.

### Fixed
- **Busy after reload** — `webview-src/App.tsx:314` `refreshActiveSessions` hydrates `busySessions` from `sessions.active` on (re)connect/resync.
- **Branch chip** scoped to `composerDirectory` (`App.tsx:722,738,1550`), diff via read-only `opencode-working-diff:` provider (`src/workingDiffDocs.ts`) instead of untitled diff doc.

## [0.6.34] - 2026-08-28

### Added
- **Usage drawer scoping**: `Total · Project · Session` (`UsageDrawer.tsx`) — chip row reuses `oc2-pop-fchip` style; Total = global `session.stats`, Project = `project.current`→`session.stats {project}` with client-aggregated `session.list` fallback, Session = synthesized from `SessionSummary`. `src/apiAdapter.ts:279` accepts `{project}`.

### Fixed
- `by model` filtered to actually-used tokens only (`total tokens > 0` after `aggregateModels`); `styles.css:1774` `.usage-scope`/`.usage-hint`.

## [0.6.32] - 2026-08-28

### Fixed
- **Plan-accent flicker**: user bubbles tagged `planAtSend: "plan"|"build"` survive server refetches via session-scoped `planOverlayRef` in `App.tsx:129`; `Feed.tsx:96` hybrid explicit+reverse-walk inference; `agentKind` threads `App:228` → `Feed:agentKind`.

## [0.6.31] - 2026-08-28

### Added
- **Session awareness**: unread dots (`time.idle`/`time.viewed`, `session.view` on open), cross-window running pulse (`sessions.active`), pulsing `session-dot.running`.
- **Auto-title (opt-in)**: `opencode2.sessions.autoTitle` (default `false`) via `AutoTitleWatcher` (`session.generate` + `session.rename` with manual-title guard).
- **Usage & stats drawer**: global totals (tokens/cost/streak/active-days, 42-day activity bars, tokens, tool reliability, by-model spend) from `session.stats` (`protocol.ts:SessionStats`); opened via status-strip cluster or `⋯ → Usage…`.
- **VCS working-tree badge**: branch chip `+N −M` from `vcs.status` (`VcsStatusSummary`); `vcs.status` RPC + `vcsLocation()` flat `location[directory]` cast bridging SDK double-nested drift; refresh on connect/focus + `filesystem.changed` → 150ms batch + 1200ms trailing timer.

## [0.6.30] - 2026-08-28

### Added
- Usage & stats drawer (initial) — `SessionStats` normalization with `finiteNum`, handles `tools.mode: "summary"` vs `"detail"` and flat `"provider/id"` model string drift.

### Fixed
- `audit-consistency.mjs` now scans all 16 components + `lib/markdown.ts` template classes; audit CLEAN.

## [0.6.28] - 2026-08-27

### Fixed
- 0.6.27 regression: historic/untagged messages stay plain; only new tagged messages get `plan`/`build` accent (`data-plan="build"`→`--oc2-user-build`, `data-plan="plan"`→`--oc2-user-plan`); send arrow SVG `14px` `strokeWidth=3`.

## [0.6.27] - 2026-08-27

### Added
- `@` mentions scoped to working folder (`directory: active.location.directory ?? workspace.directory`); external `https` links now `url.open`; send arrow 18px/800.

### Fixed
- Sticky subtle accent border on user bubbles (`styles.css:792` with per-theme `--oc2-user-build/plan`); reasoning/thinking text italic+muted.

## [0.6.25] - 2026-08-27

### Changed
- Auto-acknowledged permissions (autoAllow / session-auto-accept) render as non-blocking plain text (`.perm-text`), not interactive card; only genuinely interactive perms keep Allow/Deny.

### Fixed
- Resync re-sends lost replies (`lostReplyIds` clears stale `RespondedTracker` mark).

## [0.6.24] - 2026-08-27

### Changed
- Question tool always renders as inline plain text (`QuestionAsText` lettered a/b/c), removed blocking `QuestionCard`/`OtherRow` (was stuck on `running`/`streaming`).

## [0.6.23] - 2026-08-27

### Added
- Question tool code-side capability detection: `controller.detectQuestionSupport()` probes `/openapi.json`, sets `ui.questionsSupported` in `ResolvedConfig`.

### Fixed
- Removed `opencode2.ui.questionsDisabled` setting.

## [0.6.22] - 2026-08-27

### Fixed
- Question reply `QuestionHTTPUnavailable` / "no pending question" now surfaces `status:"unsupported"` notice instead of silent steered fallback hang.

## [0.6.21] - 2026-08-26

### Fixed
- Hardened providerish regex (`PROVIDERISH_RE`) + auto-recover once per session within 30s of compaction via model-switch+resend.

## [0.6.19] - 2026-08-26

### Added
- External directory prompt even in autoAllow, per-session "Allow for session" button; permission cards render even with no active session; message actions (copy/regenerate/edit-prefill); completed tool cards auto-compact; question watchdog.

## [0.6.18] - 2026-08-26

### Fixed
- Verified question HTTP surface absent (all `question*` routes 404 on beta-18314/dev-18341); 404 → `QuestionHTTPUnavailable`; re-pinned `@opencode-ai/client@beta-18314`.

## [0.6.15 - 0.6.17] - 2026-08-26

### Added
- Question batch via `session.question.reply` (`answers: string[][]`) with `Continue (X/Y)`; `question.list` merges Location + session lists; batch accordion (`expandedIdx`); ingestion filter strips system-reminders.

## [0.6.10 - 0.6.14] - 2026-08-26

### Fixed
- Suppress `<system-reminder>` / `You are (in|NO LONGER in)` variants; busy glow moved to send button; `steer` vs `queue` semantics corrected; ghost queued bubbles; compacting pill in-feed.

## [0.6.9] - 2026-08-26

### Added
- Plan-mode dedup with whole-UI tint; lazy first-session on first send; `Start opencode2` CTA when no instance running; Windows hide + Linux cross-platform, opencode2-only.

## [0.6.7] - 2026-08-26

### Fixed
- P0: new sessions now carry validated model binding (`opencode/big-pickle` with free-Zen fallback via `pickNewSessionModel`); fresh sessions no longer fail silently due to provider data-policy.
- Native pre-apply diff review (`permission.asked.metadata.files[]` → `opencode-diff:` provider, `diffPatch.ts` applier).
- Code Mode visualizer (`execute` tool timeline + per-server `mcp.codemode` toggle).
- Subagent inspector via `parentID` child sessions.
- Plan checklist (`implementation_plan.md`).
- Reconnect banner with restart + last-session restore.
- Re-pinned client to beta-18230 (later 18314 in 0.6.18).

## [0.3.37] - 2026-08-25

### Added
- Full V2 GUI parity shipped; docs consolidated (`plan.md`/`todo.md`/`AUDIT_AND_PLAN.md` removed). Living docs = `agents.md` + `README.md` + `MEMORY.md`.

---

[Unreleased]: https://github.com/Mrakulis/opencode2-vscode/compare/v0.6.43...HEAD
[0.6.43]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.43
[0.6.42]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.42
[0.6.41]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.41
[0.6.40]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.40
[0.6.39]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.39
[0.6.38]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.38
[0.6.37]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.37
[0.6.36]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.36
[0.6.35]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.35
[0.6.34]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.34
[0.6.32]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.32
[0.6.31]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.31
[0.6.30]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.30
[0.6.28]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.28
[0.6.27]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.27
[0.6.25]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.25
[0.6.24]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.24
[0.6.23]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.23
[0.6.22]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.22
[0.6.21]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.21
[0.6.19]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.19
[0.6.18]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.18
[0.6.15 - 0.6.17]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.17
[0.6.10 - 0.6.14]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.14
[0.6.9]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.9
[0.6.7]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.6.7
[0.3.37]: https://github.com/Mrakulis/opencode2-vscode/releases/tag/v0.3.37
