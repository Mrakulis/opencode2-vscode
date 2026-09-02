Question form rework (per your spec) + all audit findings. Release as v0.6.45.

## 1. Question form — one form per question, hand the turn back to the user
Files: webview-src/components/Feed.tsx, webview-src/App.tsx, webview-src/styles.css, webview-src/lib/questions.ts (new), test/questions.test.ts (new)

**Feed.tsx — revived QuestionCard (adapted from git history fdc34c8~1), redesigned:**
- **1 form per question**: each question in a tool call renders as its OWN form block — question title, clickable option buttons (label + description), and a free-text "Other…" row. No accordion, no combined batch form, no "Continue (X/Y)" button.
- Forms are clickable **regardless of tool status** (the server parks/aborts the tool; the answer is just a chat message). After a click, that question's form shows `✓ answered: …` and locks; others stay open.
- Click → send the option label as a chat message; prefixed `"QuestionTitle: "` only when the call has multiple questions (Other row likewise) so messages stay self-describing.
- `parseQuestionInput` handles the object shape AND the raw JSON string the SDK emits while streaming (no "no question data" flash).
- Remove now-unused QuestionAsText; drop the `static` class on the interactive card; fix stale comments in the region (:71 dangling `onAnswer` JSDoc, :1218 wrong `questionsSupported` comment).

**App.tsx — wiring, auto-stop, un-busy, delivery:**
- **Auto-hand-back**: when a `question` tool part reaches status `running` in the ACTIVE session and hasn't been handled yet (ref-guarded per toolPartId), fire the same interrupt the ■ Stop button uses (`prompt.interrupt`). The agent genuinely stops (server idle) instead of parking forever — this is what makes the answer a REAL message that starts a new turn, instead of a steer/queue that waits forever. The question card itself stays visible from `state.input`.
- **Un-busy immediately** (covers the gap before the interrupt lands): `hasOpenQuestion` = active session has a running/streaming question part; derived `busy = busySessions[activeId] && !hasOpenQuestion` (single point :260 → busy bar, Composer, StatusStrip all follow). Normal busy/idle resume on subsequent events.
- **Sending answers**: click → `sendMessage`. When idle → plain message (new turn). If a run is already active again (e.g. you answered Q1 and the agent restarted), the `busySessionsRef` fallback attaches `delivery: "steer"` so the answer is never lost. Explicit queue toggle still wins.
- **Answered overlay**: `questionAnswersRef` (`Map<sessionId, Map<toolPartId, (string|null)[]>>`, 1k cap) re-applied after every refetch/ingestion, so `✓ answered` survives refetches and session switches. Mark optimistically on click; revert + `setNotice("Send failed — …")` on failure.
- Thread `questionAnswers` + `onQuestionAnswer` through Feed → MessageGroup → Part → ToolCard (the old onAnswer path).

**styles.css**: restore the `.q-*` block (q-item/q-title/q-opt/q-label/q-desc/q-note/q-other/q-other-input) from git history — audit CSS stays CLEAN.

## 2. Extension server / config (audit majors + minors)
- **src/extension.ts (MAJOR)**: `affectsConfiguration("opencode2.server.listen")` never matches — replace with explicit checks over the six `listen*` keys. Companion changes resync without daemon reconnect; Settings-UI toggles start/stop the server.
- **src/extensionServer.ts + src/listenConfig.ts (MAJOR, security)**: `Host` header validation — missing → 400; loopback binds require a loopback host part → else 403 (closes DNS rebinding on the no-password loopback config). Pure `parseHostHeader()` + tests.
- **src/extensionServer.ts (minor)**: single-notify listen errors (permanent error handler attached after successful listen; one message on failure before rethrow).
- **src/rpc.ts (minor)**: `companion.update` validates ALL params before writing any config (atomic).

## 3. Usage drawer + misc (audit minors)
- **UsageDrawer.tsx**: remove `next!` (hoist narrowed const); stale-response guard (`requestIdRef`) so rapid scope switches can't render the wrong numbers.
- **CompanionDrawer.tsx**: `copyUrl` surfaces a transient error instead of silent `catch {}`.
- **controller.ts:54**: comment fix — `Service.ensure` → hidden spawn.

## 4. Tests + gate
- New `test/questions.test.ts`; `parseHostHeader` cases in `test/listenConfig.test.ts`.
- Gate: `npm run typecheck` + `npm test` + `npm run build` + `npm run audit` — all must pass.

## 5. Release
`package.json` → 0.6.45; CHANGELOG (incl. correction note: 0.6.44's `server.listen` narrowing was a behavioral no-op); MEMORY.md; commit `feat(questions): v0.6.45 — per-question forms, auto-hand-back on question, audit fixes`; tag `v0.6.45`; push master + tag; `npm run package` → `vsix/`.

## 6. Explicitly excluded (discussed, with reasons)
- Dead `question.list`/`question.reply` RPC + adapter wrappers + `detectQuestionSupport` removal — protocol/adapter P1, zero behavior gain.
- `0.0.0.0` URL display, port-input snapping, >26-option lettering, `state.output` rendering, `kind-question` accent CSS — cosmetic.
- `worktree.create` canonicalization — pre-existing, input already canonical upstream.