# Plan: OpenCode 2 for VS Code

A VS Code sidebar client for OpenCode, built natively on the **OpenCode V2 API system** (`@opencode-ai/client@beta`). The UI/UX is designed around what V2 makes possible and how VS Code itself behaves.

- Workspace: `E:\_Code\Opencode2 VS Code Extention` (currently empty — fresh project)
- Status: **planning** — no code written yet

---

## 1. Research summary

### 1.1 The V2 platform contract

Source: https://opencode.ai/v2/docs/ (+ `/v2/docs/build/client`, `/v2/docs/api`), OpenAPI spec saved locally at `%TEMP%\opencode-v2-openapi.json`.

**Client package:** `@opencode-ai/client@beta` the only supported client package. Entrypoints:
- `@opencode-ai/client` — browser-compatible Promise client: `OpenCode.make({ baseUrl, headers })`
- `@opencode-ai/client/service` — **Node-only** service lifecycle: `Service.discover()`, `Service.ensure()`, `Service.stop()`, `Service.headers(endpoint)`. Replaces all manual spawn/port management.
- `@opencode-ai/client/effect` — Effect-TS variant (not needed for us)

**Key platform behaviors:**
- No more hardcoded `http://127.0.0.1:4096` + manual `opencode serve` spawn as primary path. V2 has a **shared background service** with a registration file; `Service.ensure()` discovers or starts it (`opencode serve --service`). Explicit server URL remains an option.
- All routes live under `/api/...`; responses wrapped in `{ data }`.
- Event stream: `GET /api/event` (SSE) → `{ id, event, data }` payloads; **volatile by contract** (miss events on disconnect; slow consumer overflows). Client exposes it as async iterable: `for await (const e of client.event.subscribe())`. Reconnect must re-sync state from REST endpoints.
- Session IDs match `^ses`.
- New capabilities worth exposing: permissions reply (`POST /api/session/{id}/permission/{requestID}/reply`), forms, inbox steer/queue, model/agent switching per session (`/session/{id}/model`, `/session/{id}/agent`), interrupt, compact, revert stages, worktrees, PTY/shell.

**Endpoints we'll use most:**

```
GET    /api/health                          → { healthy, version, pid }
GET    /api/session                         list
POST   /api/session                         create ({ title?, agent?, model?, location? })
GET    /api/session/{id}                    get
DELETE /api/session/{id}                    remove
GET    /api/session/{id}/message            messages
POST   /api/session/{id}/prompt             send text ({ text required, files?, agents?, delivery?, resume? })
POST   /api/session/{id}/interrupt          stop generation
POST   /api/session/{id}/model              switch model
POST   /api/session/{id}/agent              switch agent
GET    /api/event                           SSE event stream
GET    /api/model · /api/agent · /api/provider   pickers
GET    /api/session/{id}/permission         permission requests
POST   /api/session/{id}/permission/{reqID}/reply   respond to permission
GET    /api/config · /api/project/current   config/workspace info
```

> Beta caveat: docs warn method names/inputs/outputs may change before stable. Pin `@opencode-ai/client@beta` exact version in package.json.

---

## 2. Proposed architecture

```
┌─────────────────────────────────────────────────────────────┐
│ VS Code Extension Host (Node)                                │
│                                                              │
│  OpenCodeController                                          │
│  ├─ Service.ensure()/discover()  ← @opencode-ai/client/service│
│  ├─ OpenCode.make({ baseUrl, headers })                      │
│  ├─ Event pump: client.event.subscribe() → reconnect loop    │
│  │    + state re-sync (REST) after gaps                      │
│  └─ CLI helpers (detect/install opencode2, open terminal)    │
│        ▲  typed RPC (postMessage protocol)                   │
│  SidebarWebviewProvider ── hosts chat UI                     │
│  SettingsPanel (optional phase)                              │
└──────────────────────┬───────────────────────────────────────┘
                       │ acquireVsCodeApi postMessage
┌──────────────────────▼───────────────────────────────────────┐
│ Webview UI (chat client)                                     │
│  sessions list · message feed (markdown/code/diffs/tool      │
│  parts) · composer · model/agent picker · permission prompts │
└──────────────────────────────────────────────────────────────┘
```

Design decisions:
1. **All server I/O stays in the extension host.** The webview never talks HTTP directly. Reasons: auth headers from `Service.headers()` are internal, avoids CSP/webview fetch issues, single reconnect owner, works even when webview is hidden (`retainContextWhenHidden`).
2. **Typed message protocol** between webview ↔ host (`webviewProtocol.ts` equivalent): request/response with ids + event push channel.
3. **State re-sync strategy**: since `/api/event` is volatile and lossy, keep canonical state server-side; on (re)connect, refetch sessions + active session messages, then apply live events incrementally. Use `GET /api/experimental/session/{id}/log` (durable log w/ follow=true) if we need gap-free per-session streams later.

### Alternative considered: embed a ready-made web client build
Vendoring a third-party web client build into the webview would give instant breadth, but means shipping hundreds of foreign chunk files and coupling to someone else's internal data layer. **Decision: own UI, own code.** Our React client is small, we control every pixel, and the only upstream surface is the pinned `@opencode-ai/client` package.
---

## 3. Project skeleton

```
E:\_Code\Opencode2 VS Code Extention\
├─ package.json            # contributes: activitybar view, commands, config
├─ esbuild.mjs             # bundle extension (node cjs) + webview (iife/esm)
├─ tsconfig.json           # extension host code
├─ tsconfig.webview.json   # webview UI code
├─ media/
│  ├─ opencode.svg         # activity bar icon
│  └─ webview/…            # built webview assets
├─ src/                    # extension host
│  ├─ extension.ts         # activation, commands, status bar
│  ├─ controller.ts        # Service.ensure + client + event pump + reconnect
│  ├─ cli.ts               # detect/install opencode2 CLI (npm fallback)
│  ├─ protocol.ts          # shared webview↔host message types
│  ├─ sidebarProvider.ts   # webview host, RPC dispatch
│  └─ util/pathUtils.ts
└─ webview-src/            # chat UI
   ├─ main.tsx
   ├─ App.tsx
   ├─ components/ (SessionList, MessageFeed, MessagePart, Composer,
   │               PermissionPrompt, ModelPicker, StatusBar)
   └─ hooks/ (useRpc, useSessions)
```

Build: esbuild for both targets (no vite needed initially); TypeScript strict; prettier.

---

## 4. Risks / open items

1. **Beta API churn** — pin exact beta version; wrap client calls in thin adapter module so changes localize to one file.
2. **Windows specifics** (this machine is win32): service registration file path, PATH resolution for `opencode2`/`opencode` binaries, shell quoting for spawn.
3. **Event payload shape** — `V2EventEncoded` is opaque JSON in the spec; we'll inspect real payloads at runtime during M2 and type them empirically (keep a `types/events.d.ts` we own).
4. **CLI naming** — V2 docs use `opencode2` for service/api commands while client default command is `opencode serve --service`; make the binary name + service command configurable, try both at detection time.
5. **Auth** — local service uses headers from `Service.headers(endpoint)`; remote/explicit servers may require bearer token setting.

## 5. Decisions (confirmed by user)
1. **Webview stack: React** (TypeScript, bundled by esbuild).
2. **Independent product.** The feature set is defined by what the V2 API enables and what a great VS Code agent sidebar needs.
3. **Branding:** "OpenCode 2 for VS Code" with `opencode2.*` settings.
4. **UI: feature-rich but clean** — see §8 control inventory; progressive disclosure keeps chrome quiet.
5. **Theming: always follow the user's VS Code theme**, differentiated via shape/typography only (§9). Density compact ⇄ comfortable, switchable.

---

## 6. Product definition

### 6.1 Core experience (designed fresh)
Open a workspace → the sidebar connects to OpenCode V2's shared background service automatically → chat with an agent that edits your code, with full visibility: streaming responses, reasoning, tool calls/diffs, permission approvals, and cost/context telemetry. Sessions persist per project; controls (model/agent/files/commands) are one click away but never in the way.

### 6.2 Reliability requirements (designed-in)
1. **Config applies everywhere**: host pushes resolved config on every change; no duplicated config logic in the UI.
2. **Windows-first startup**: rely on service discovery, never parse process output for URLs.
3. **Sidebar toggle command** exists so keybinds can open *and* close it.
4. **Reasoning blocks** are collapsible and visually distinct from answers.
5. **Auto-compact watcher**: token usage crossing a configurable threshold triggers compaction.
6. **Composer markdown preview**: live toggle before sending.
7. **Own UI surface**: small React client; upstream surface limited to the pinned client package.
### 6.3 Capabilities unlocked by V2

1. **Permission prompts in-editor**: poll/listen permission requests → inline approval card (allow once / always / deny) via `/permission/{reqID}/reply`; optional OS notification + sound.
2. **Per-session model & agent switching** pickers (`/model`, `/agent`, `session/{id}/model|agent`) instead of restart-to-change.
3. **Interrupt + compact buttons**, queue/steer follow-ups via inbox endpoints.
4. **Cost & token usage badge** per session from `Session.Info` (cost, tokens).
5. **Diff review**: tool/file diffs surfaced via `/api/vcs/diff` + revert stage controls.

---

## 7. Milestones (final)

- **M0 Scaffold**: React + esbuild dual-target build, `package.json` contributions under `opencode2.*`, icon, hello-world sidebar.
- **M1 Connection**: controller with `Service.ensure()`, health, status bar, commands (focus/toggle/restart/refresh/terminal/install CLI), settings namespace, output-channel logging.
- **M2 Chat MVP**: RPC protocol, session list CRUD, message fetch/render (markdown, code highlight, reasoning blocks), composer with markdown preview, streaming, interrupt, reconnect-resync.
- **M2 Chat MVP**: RPC protocol, session list CRUD, message fetch/render (markdown, code highlight, reasoning blocks), composer with markdown preview, streaming, interrupt, reconnect-resync. Density var system + toggle lands here.
- **M3 Agent controls**: model/agent pickers, permissions UX, cost/token badges + ctx meter, auto-compact.
- **M4 Productization polish**: notifications/sounds toggles, accent-tint setting, multi-root location handling, diff review, packaging (vsce), README, tests.

---

## 8. UI specification (control inventory)

Principle: **every control earns its place** — dense, quiet chrome; progressive disclosure (collapsed tool cards, drawers); no double scrollbars; keyboard-first.

### 8.1 Layout (single sidebar column)

```
┌──────────────────────────────────────────┐
│ HeaderBar                                │
│ [≡ sessions] Title (dbl-click rename) ⋯  │  ← overflow menu
│ [model ▾] [agent ▾]        ◉ idle        │
├──────────────────────────────────────────┤
│ MessageFeed (scroll)                     │
│  · user bubble                           │
│  · reasoning ▸ (collapsed, tinted)       │
│  · assistant markdown                    │
│  · tool card ▸ (one-line → expandable,   │
│    diffs rendered inside)                │
│  · permission card [Allow][Always][Deny] │
├──────────────────────────────────────────┤
│ Composer                                 │
│ [chips: @file  /cmd] (contextual popup)  │
│ ┌ textarea (auto-grow, md preview ⃝) ┐   │
│ [📎 attach] [/] [@]      [Send ▷|■ stop]│
├──────────────────────────────────────────┤
│ StatusBar strip                          │
│ ●connected · $0.012 · 4.2k tok · ctx ▓▓░ │
└──────────────────────────────────────────┘
```

### 8.2 Controls

| Area | Controls | Notes |
|---|---|---|
| Header | Sessions drawer (search, pin, archive, delete w/ confirm) | slides over feed, Esc closes |
| | Inline-rename title | Enter/Esc commit |
| | Model picker | fuzzy-search combobox from `/api/model`, shows context limit |
| | Agent picker | `/api/agent`; per-session switch |
| | Overflow menu (⋯) | export/copy transcript, fork, compact now, revert stage |
| Feed | Reasoning block | collapsed by default, distinct tint |
| | Tool card | icon+verb+target one-liner; expand → args/result/diff |
| | Diff viewer | unified, +/- gutter colors from VS Code theme |
| | Message hover actions | copy, retry-from-here (fork) |
| | Streaming caret; auto-scroll w/ "jump to latest" pill | pauses when user scrolls up |
| Composer | Auto-grow textarea (max ~40vh) | Enter=send, Shift+Enter=newline |
| | Markdown preview toggle | #2/#6 fix |
| | `@` file mention | fuzzy file finder via `/api/fs/find`, inserts chip |
| | `/` command & skill menu | from `/api/command`, `/api/skill` |
| | Attachment chips | prompt `files[]`; remove per chip |
| | Send ⇄ Stop morphing button | stop = `interrupt` |
| | Queued-followup indicator | while busy: send queues (inbox/queue) or steers (steer) — user choice chip |
| Permission | Inline card w/ expiry dim | allow once / always (saved list) / deny; OS notification optional |
| Status strip | connection dot, cost, tokens, **ctx meter** | meter drives auto-compact visibility |
| Global | Command palette entries for all actions; keybinds |; includes explicit sidebar toggle |

### 8.3 Interaction rules
- All async controls show optimistic state + rollback; no spinners longer than 300ms without skeleton.
- Empty states are actionable ("New session", "Start CLI"), never blank.
- Everything theme-aware via CSS vars (works light/dark/high-contrast).

---

## 9. Theming ("of VS Code, not next to it")

**Decision:** the UI must feel native to the user's editor. It **always follows the active VS Code theme** (light/dark/high-contrast automatically). No parallel palettes.

### 9.1 Base layer — 100% `--vscode-*` variables
Surfaces, text, borders, inputs, badges, scrollbars, focus outlines all map to editor tokens:
`--vscode-sideBar-background`, `-foreground`, `-editorWidget-background`, `-input-background`, `-button-background`, `-badge-background`, `-textLink-foreground`, `-editorGutter-added/deleted` (diffs), etc. Result: any marketplace theme works day one.

### 9.2 Brand layer — the "little different"
Identity through **shape & typography**, not color clashes:
- Mono-font micro-labels for status strip, chips, tool-card verbs (`JetBrains Mono → Cascadia → ui-monospace` stack).
- Hairline separators, 6px pill radii, no drop shadows.
- A 2px accent top-line on the header + accent used only for live states (streaming caret, send button, ctx-meter fill).
- Optional single setting `opencode2.ui.accentTint`: `off` (default) or an hex/CSS color that tints accents while everything else stays theme-true.

### 9.3 Density
- `opencode2.ui.density`: `"compact"` (default, 13px base / tight paddings) ⇄ `"comfortable"` (14px / roomier).
- Toggle lives in overflow menu (applies instantly via CSS var swap, persists to settings).
- Implemented as one CSS custom-property set (`--oc2-space-*`, `--oc2-font-*`) so components never hardcode sizes.
