# OpenCode 2 for VS Code — Full Functionality Audit & Remediation Plan

> **Date:** 2026-08-23. **Scope:** v0.2.37. **Status:** APPROVED — all Open Questions resolved (recommendations accepted; Q18=all events, Q22=include worktrees, Q25=confirmed opencode2). Ready for implementation: start **M-theme**, then **M5**.
> **Direction (confirmed):** GUI-first extension UX (not a TUI/CLI clone). **Our own theme now**; official OpenCode themes added later for authenticity.
> **How to use this doc:** §1–§4 are the audit. **§5 is the Open Questions & Decisions log** — read it and write your answers on the `ANSWER:` lines (or as comments). §6 is the milestone plan (defaults already applied from recommendations). Once you've annotated §5, we commit the review and start implementing.
> **Sources:** full source (`src/`, `webview-src/`), pinned client `@opencode-ai/client@0.0.0-beta-17927` type defs, V2 OpenAPI spec (`%TEMP%\opencode-v2-openapi.json`, 100 paths / 231 schemas), V2 docs via Context7.
>
> **V1 vs V2 boundary (critical):** We implement **V2 only**. Every API call, endpoint, event, config key, and command is V2 (`@opencode-ai/client` + the V2 OpenAPI). The **OpenCode V1 desktop app is referenced SOLELY for UX inspiration** — i.e., *how* features like slash menus, forms, and permission prompts are *presented* — never for API/config/command semantics. Do **not** adopt any V1 TUI command names, V1 config shapes (`permission.bash`, `command:`→`commands:`, etc.), or V1 event behavior. When in doubt, the V2 OpenAPI spec + V2 client types are the only source of truth.

---

## 1. Executive summary

The extension is **solid and works** for its core loop: auto-connect → chat → streaming → tool/diff/reasoning rendering → per-session model/agent switching → permission approvals → cost/token/context telemetry → MCP & provider drawers. Typecheck + tests + build gate is green and the connection layer is robust (service discovery, auto-start, backoff, volatile-event resync).

**But there is a large capability gap vs. the V2 API and the OpenCode desktop app.** Of the **~120 client methods** in `@opencode-ai/client`, the extension uses **~25**. The RPC surface exposes **34 methods**; the V2 `V2Event` union has **100+ event types** but the webview handles **~8**. Most importantly, the user-facing **slash-command and skill surface is entirely missing** — exactly the gap called out in the brief — even though `plan.md §8.2` and the README promise a `/` command & skill menu and `@` file mentions.

**Headline gaps (verified):**
1. **No slash commands** (`/command` catalog + `session.command`), **no skills** (`skill.list` + `session.skill`), **no `@` file mention** in the composer (API exists: `file.find` is wired host-side but never surfaced).
2. **No real Forms** — the app guesses "the agent is asking a question" by regex-parsing assistant text. V2 has a full `form.*` API + `form.created` events that should replace this.
3. **Event handling is thin** — ~92 of 100+ event types ignored; UI refreshes via a coarse "any `session.*` event → refetch list" rule.
4. **Feature-parity gaps with the desktop app**: `/export`+`/import`, `/undo`+`/redo` (Git-backed revert), `/connect` (in-app provider OAuth/key vs. today's `opencode2 auth login` CLI handoff), `/init` (instructions), `/themes`/`/thinking`, `/share`+`/unshare`, VCS diff/status, worktrees, saved-permission management.
5. **Documented-but-unsurfaced**: README claims "Queue or steer follow-ups while the agent is working" — `delivery: queue|steer` exists in the adapter but **no UI** lets the user choose it.
6. **Latent bug**: `rpc.ts` hard-codes `opencode2 auth login` and `extension.ts` falls back to `"opencode2"`, but `installCli` installs `opencode-ai@beta` whose binary is **`opencode`** — so on a machine with only the npm binary, provider auth and "Open Terminal" fail.

**Theming pivot:** we are **not** following the VS Code theme. `plan.md §9` is superseded. We ship **our own design language** now; official OpenCode themes come later as selectable presets. **Verified:** `styles.css` already uses a first-party `--oc2-*` token system (`:root` + `[data-density]` + `[data-plan]`), with **0** `--vscode-*` references — token *values* are just hardcoded to the VS Code Dark+ palette. So M-theme is a **rebrand + light-theme + switcher**, NOT a token-system rewrite (see §4, §5 Q1–Q7, §6 M-theme).

---

## 2. What is verified working

| Area | Status | Evidence |
|---|---|---|
| Auto-connect (discover → ensure → explicit URL) | OK | `controller.ts` + live smoke in MEMORY |
| Health / status bar / reconnect + backoff | OK | `controller.ts`, `extension.ts` |
| Session CRUD + fork + folder-scoped list + all-projects toggle | OK | `apiAdapter`, `rpc`, `SessionsDrawer` |
| Streaming chat (reasoning, tool cards, inline diffs) | OK | `Feed.tsx`, `App.tsx` event pump → debounced `messages.list` |
| Per-session model/agent/variant switching | OK | `Composer.tsx`, `ModelManager.tsx` |
| Permission approve (once/always/deny) | OK | `notifications.ts`, `App.tsx` |
| Cost/token/context telemetry + auto-compact | OK | `StatusStrip`, `autoCompact.ts` |
| MCP drawer (CRUD + connect/disconnect + resources) | OK | `McpDrawer.tsx`, `rpc.mcp.*` |
| Providers drawer + CLI auth handoff | WARN only if `opencode2` binary present (see §4.6.1) | `ProvidersDrawer.tsx`, `rpc.ts:145` |
| Theming | CHANGED own theme (currently still `--vscode-*`; rework needed, §5 Q1) | `styles.css`, `protocol.ts` |
| Notifications + sounds | OK | `notifications.ts`, `lib/sound.ts` |
| Build / typecheck / tests gate | OK green (29/29) | `package.json` scripts |

---

## 3. Audit findings (detailed)

### 3.1 Missing slash commands & skills — THE headline gap (V2-only)
**V2 mechanism (authoritative):** V2 exposes a command system via `GET /api/command` (`client.command.list()`) and `POST /api/session/{id}/command` (`client.session.command`), plus skills via `GET /api/skill` (`client.skill.list()`) and `POST /api/session/{id}/skill` (`client.session.skill`). Built-in **and** custom commands are returned by `command.list()` (custom commands come from V2 `commands:` config + `.opencode/commands/*.md`), each tagged with a `source` (`command` | `mcp` | `skill`). **The extension must source its slash menu entirely from V2 `command.list()` + `skill.list()` — we do NOT hardcode command names, and we do NOT use any V1 TUI command list.**

The extension has **none of this in the composer** (`Composer.tsx` only has agent/model/variant/permission pickers). As a **GUI-first** app these become native affordances (command popover, fuzzy file picker, skill chips, native forms), not a terminal line.

> **Reference vs. fact:** The table below is an *illustrative* list gathered from OpenCode docs/blogs that may mix **V1 TUI** commands with V2. It is **NOT** the source of truth. At implementation, the actual built-in set = whatever V2's `command.list()` returns. Rows marked **(TUI-only)** are terminal-era commands not applicable to a VS Code GUI and are very likely V1 — ignore them. Validate every name against V2 before wiring a first-class UI action.

| Command | Purpose | V2 API / UI action | Applies to V2 GUI? |
|---|---|---|---|
| `/connect` | Add provider + API key | `integration.connect.{key,oauth,command}` | Yes (in-app connect) |
| `/compact` (`/summarize`) | Compact session | `session.compact` | Yes (button exists) |
| `/details` | Toggle tool details | UI pref `expand*Tools` | Yes (via settings) |
| `/editor` | Compose in $EDITOR | n/a in VS Code | **(TUI-only) ignore** |
| `/exit` `/quit` `/q` | Exit | n/a | **(TUI-only) ignore** |
| `/export` | Export convo to Markdown | `session.export` | Yes |
| `/help` | Help dialog | n/a | **(TUI-only) ignore** |
| `/init` | Guided `AGENTS.md` setup | `session.instructions.entry.*` | Yes |
| `/models` | List models | `model.list` | Yes (picker) |
| `/new` (`/clear`) | New session | `session.create` | Yes (button) |
| `/redo` | Redo after undo (Git-backed) | `session.revert.commit` | Yes |
| `/sessions` (`/resume`) | List/switch sessions | `session.list` | Yes (drawer) |
| `/share` | Share session | (server share link) | Maybe (if V2 supports) |
| `/themes` | List themes | our theme switcher (later official presets) | Yes (our switcher) |
| `/thinking` | Toggle reasoning | `ui.showReasoning` | Yes (via settings) |
| `/undo` | Undo last turn + revert files | `session.revert.stage`→`commit` | Yes |
| `/unshare` | Unshare | (server) | Maybe (if V2 supports) |
| `@<file>` | Fuzzy file inject | `file.find` + prompt `files[]` | Yes |
| `!<shell>` | Run shell, add as result | `session.shell` | Optional GUI affordance |

### 3.2 Missing V2 capabilities (endpoint/method coverage)
Client method surface ≈ 120; **used ≈ 25**.

| Group | Available, not used | Value |
|---|---|---|
| Session | `import`, `export`, `active`, `move`, `synthetic`, `shell`, `wait`, `background`, `message.get`, `environment`, `view`, `agent.get`, `server.get`, `location.get` | export/import, move session, shell in-session, background runs |
| **Revert** | `revert.stage` / `revert.clear` / `revert.commit` | `/undo` + `/redo` Git-backed file reversion |
| **Context** | `session.context` | precise token/context (today approximated) |
| **Inbox** | `inbox.list` / `cancel` / `steer` / `queue` | steer/queue individual items |
| **Instructions** | `instructions.entry.list/put/remove` | `/init` project rules |
| **Forms** | `form.request.list`, `form.list/create/get/state/reply/cancel` | structured agent input |
| **Permissions** | `permission.saved.list/remove`, `permission.create/list/get` | manage "always allow" rules |
| **Integration** | `integration.get`, `wellknown.add`, `connect.key`, `oauth.*`, `command.*` | in-app provider connect |
| **MCP** | `credential.update/remove` | manage MCP secrets |
| **Project/Config** | `project.list`, `project.current`, `config.get` | workspace + agent context |
| **File** | `file.read`, `file.list` | richer file preview / tree |
| **Command/Skill** | `command.list`, `skill.list` | slash menu source |
| **VCS** | `vcs.get` / `status` / `diff` | branch chip + session diffs |
| **Worktree** | `worktree.list/create/remove/refresh` | worktree UI |
| **Websearch** | `websearch.providers` / `query` | expose web search |
| **Plugin** | `plugin.list` | surface loaded plugins |
| **PTY/Shell** | `pty.*`, `shell.*` | in-session terminal (advanced) |

### 3.3 Event-handling coverage
`V2Event` union has **100+** members. Webview handles only: `session.execution.started/succeeded/failed/interrupted`, `session.idle`, `permission.asked`, plus a coarse `startsWith("session."|"permission."|"execution."|"message.")` → debounced refetch.
**Unhandled but valuable:** `session.text.delta`/`reasoning.delta`/`tool.*` (true streaming), `session.model/agent.selected`/`renamed`/`moved` (targeted refresh), `form.*` (real forms), `mcp.status.changed`/`resources.changed`, `integration.updated`/`connection.updated`, `config.updated`, `vcs.branch.updated`, `worktree.*`, `session.revert.*`, `session.compaction.*`, `session.inbox.*`, `session.instructions.updated`, `command.updated`, `skill.updated`, `plugin.*`, `websearch.updated`, `reference.updated`, `session.shell.*`, `session.skill.activated`.
**Recommendation:** explicit typed event router (`Record<EventType, handler>` or switch); keep REST `onResync` re-sync as safety net.

> **V2-only events to ignore:** the V2 `V2Event` union also includes `Tui*` events (`TuiPromptAppend`, `TuiCommandExecute`, `TuiToastShow`, `TuiSessionSelect`) and `Installation*` events. These are for the V2 **TUI client** / CLI self-update and are **not** relevant to this VS Code GUI — do not handle them.

### 3.4 Message/content rendering gaps
`SessionMessageInfo` is a **union of 10 types**; the webview models only `user` + `assistant` (others return `null`). Assistant tool-content can be `{type:"file"}` (e.g., a tool-produced image) — `ToolCard` only renders `{type:"text"}` and `diff`, so tool file/image outputs are dropped. User-uploaded images sent via `files[]` render only as text in the bubble.

### 3.5 Documented-but-unsurfaced
README: *"Queue or steer follow-ups while the agent is working"* — `delivery` is plumbed in `apiAdapter.prompt` but **no composer UI** lets the user pick queue-vs-steer.

### 3.6 Bugs / behavior issues
1. **Binary-name mismatch (confirmed).** `rpc.ts:145` `opencode2 auth login` and `extension.ts:90` fallback `"opencode2"`, but `installCli` installs `opencode-ai@beta` → binary **`opencode`**. Provider auth + "Open Terminal" fail on a machine with only the npm binary. Fix: use resolved `ResolvedCli.display`.
2. **Fragile question detection.** `App.tsx` `isQuestion` regex-parses assistant text for `?` / "please confirm" → mis-fires on FAQs/release notes. Replace with real `form.*`.
3. **`permissions.mode` vs server.** `askFirst/autoAllow/deny` drives only client-side auto-reply; not clearly wired to server permission behavior. Align in M7.
4. **Stray debug command.** `opencode2.showTestQuestion` ships in production. Remove or gate.

### 3.7 GUI-first UX direction (not TUI/CLI)
A **bespoke VS Code GUI sidebar**, not a terminal clone:
- Slash commands → polished **command popover** (Copilot-chat style), not a raw terminal line.
- `@` file mention → inline **fuzzy picker popover**.
- `!` shell → optional GUI affordance, not a shell prompt (deferred per §5 reply).
- Forms → native `FormCard` components styled in our theme.
- Avoid terminal aesthetics (monospace-everywhere, `$` prompts) except where useful (shell tool output).
- The OpenCode **V1 desktop app** is referenced **for UX inspiration only** (how features like slash menus / forms / permissions are *presented*); official OpenCode themes are a separate V2 concept we add later. Neither is a source of API/config/command semantics — V2 only.

---

## 4. Retained design vs. changes required (impact of the audit plan on v0.2.37)

> **Answer to "how much of my design stays vs. changes":** the vast majority survives. Only two change-categories exist: (A) a **contained theme rebrand** — the token system already exists as `--oc2-*` (verified **0** `--vscode-*` refs), so it is rebrand + light theme + switcher, *not* a rewrite; and (B) **additive feature layers** (M5–M8) on top of stable components. A handful of specific logic spots get *replaced* (heuristic/bug fixes). See the table.

### 4.1 What stays (unchanged or lightly extended)
| # | Existing design decision | Disposition |
|---|---|---|
| 1 | Architecture: host/UI split, RPC-over-postMessage, all server I/O in `apiAdapter`/`controller` | **STAY** |
| 2 | Connection: `Service.discover/ensure`, explicit baseUrl, auto-start, backoff, volatile-event resync | **STAY** |
| 3 | Styling token *system* (`--oc2-*` `:root` + `[data-density]` + `[data-plan]`) | **STAY** (structure); values rebranded (A) |
| 4 | Density system (`data-density` compact/comfortable, `--oc2-space/font`) | **STAY** |
| 5 | Accent tint (`opencode2.ui.accentTint` → `--oc2-accent`) | **STAY** |
| 6 | React webview component architecture (`components/`, `lib/`, hooks) | **STAY** |
| 7 | Composer (auto-grow textarea, Enter/ctrlEnter, markdown preview, model/agent/variant/permission pickers) | **STAY + EXTEND** (slash popover, `@` mention, queue/steer chip) |
| 8 | Feed (user bubble, collapsible reasoning, tool cards + diff, streaming caret, jump-to-latest) | **STAY + EXTEND** (FormCard, tool file/image parts, meta-message handling) |
| 9 | Drawers (Sessions, ModelManager, Providers, Mcp) | **STAY + EXTEND** (Providers in-app connect, Mcp credentials, instructions drawer) |
| 10 | Permission cards / `permissions.mode` | **STAY + EXTEND** (saved-permission manager, server alignment) |
| 11 | RPC protocol (`RpcMethod` union, `SETTING_KEYS`, validation) | **STAY + EXTEND** (new methods) |
| 12 | `apiAdapter` (single client-call module) | **STAY + EXTEND** (new V2 calls) |
| 13 | Event pump / controller (subscribe loop, drop detection, resync) | **STAY + EXTEND** (typed router in webview) |
| 14 | `autoCompact` watcher | **STAY** |
| 15 | Notifications + sounds | **STAY + EXTEND** (new event types) |
| 16 | Settings schema (`opencode2.*`) | **STAY + EXTEND** (theme selection) |
| 17 | esbuild dual-target build, tsconfigs, tests | **STAY** |
| 18 | `cli.ts` detection | **STAY + FIX** (use `ResolvedCli.display`, Q25) |
| 19 | Command contributions / keybindings | **STAY** (− `showTestQuestion`, Q26) |

### 4.2 What gets replaced (not just extended)
- **`App.tsx` `isQuestion` regex heuristic** → real `form.*` UI (M6).
- **`App.tsx` coarse `startsWith("session.")` event refresh** → explicit typed event router (M7).
- **Literal `opencode2` in `rpc.ts:145` / `extension.ts:90`** → `ResolvedCli.display` (Q25; preserves your `opencode2`).
- **`App.tsx` inline hex `#c084fc`** (question cards) → route through a token.
- **`styles.css:3` stale comment** ("Base layer = VS Code theme variables…") → fix.
- **`plan.md §9` + README claims** ("follows VS Code theme", queue/steer) → corrected docs (M8/Q30).

### 4.3 Effort reality check
The originally-estimated "rip out `--vscode-*`" rework **does not apply** (there are none). M-theme is effectively: edit the `:root` palette block (~20 lines), add a `[data-theme="light"]` block, add a theme switcher (settings + overflow), fix one comment + a few inline hex. That is a small, contained change — not a stylesheet rewrite. All of M5–M8 is additive on top of the stable components above.

---

## 5. Open Questions & Decisions — REVIEW AND FILL IN

> Read this section and write your answers on the `ANSWER:` lines (or as `<!-- -->` comments). **STATUS: APPROVED.** All questions resolved; recommendations accepted. Confirmed-in-review exceptions: **Q18 = wire ALL events**, **Q22 = INCLUDE worktrees**, **Q25 = confirmed binary is `opencode2`** (fix preserves it). All other blank `ANSWER:` lines accept the Recommendation stated directly above them.

### A. Theming (our own theme + later official OpenCode themes)

**Q1. Transition strategy for the styling layer.**
Context: Verified — `styles.css` has **0** `--vscode-*` references; it already uses a first-party `--oc2-*` token system (`:root` + `[data-density]` + `[data-plan]`), with values currently hardcoded to the VS Code Dark+ palette. No TS reads the VS Code theme. The plumbing is already ours.
Recommendation: No rip-out needed (nothing to remove). Rebrand the `:root` palette to our brand (dark + light via `[data-theme]`), add a theme switcher (settings + overflow), and later add official OpenCode presets as `[data-theme="..."]` blocks. Route the few inline hardcoded hex (e.g., `App.tsx` `#c084fc`) through tokens.
ANSWER: Obsolete as rip-out/shim — token system already first-party; rebrand palette + add light theme + switcher (per above).

**Q2. Default theme coverage.**
Context: Do we ship dark-only, light-only, or both from day one?
Recommendation: **Dark + Light** from day one (our own designs), High-Contrast later if needed.
ANSWER: ___

**Q3. Brand accent / primary color for the default theme.**
Context: Defines our identity; also used for live states (send, streaming caret, ctx meter).
Recommendation: A violet/indigo in the OpenCode family (e.g. `#7c5cff`/`#8b5cf6`) so the later official themes feel continuous.
ANSWER: ___

**Q4. Typography.**
Context: Keep mono micro-labels for status strip/chips? Font stack?
Recommendation: Keep subtle mono micro-labels (identity via shape/typography); system UI font for body; keep `data-density` (compact/comfortable).
ANSWER: ___

**Q5. Density.**
Context: Keep compact ⇄ comfortable toggle?
Recommendation: Yes, keep `opencode2.ui.density` (compact default).
ANSWER: ___

**Q6. Official OpenCode themes — sourcing & loading.**
Context: Later milestone to "feel more authentic." How do we get them and apply them?
Recommendation: Source the official theme definitions from the OpenCode repo (reference) as **static CSS preset files** (light/dark/high-contrast), selected via our theme switcher; no runtime fetch.
ANSWER: ___

**Q7. Theme switching surface.**
Context: Where does the user pick a theme?
Recommendation: Settings (`opencode2.ui.theme`) + overflow menu item; persists to global config.
ANSWER: ___

### B. Slash commands / skills / `@` mention (decided: inline `/` popover)

**Q8. Which built-ins get first-class UI vs sent via `session.command`?**
Context: We must NOT hardcode V1 TUI command names. The V2 built-in set = whatever V2 `command.list()` returns; some commands are terminal-era and not applicable to a GUI.
Recommendation: Treat V2 `command.list()` (+ `skill.list()`) as the source of truth; render all returned entries in the popover badged by `source`. For first-class UI beyond the popover, wire the V2-relevant ones we confirm exist (e.g., `/export`, `/undo`, `/redo`, `/compact`, `/new`, `/sessions`, `/thinking`, `/connect`→Providers, `/init`→instructions) and send the rest via `session.command`/`session.skill`. Ignore TUI-only names (`/exit`, `/editor`, `/help`, `/clear`).
ANSWER: ___

**Q9. How to open the slash popover (keyboard).**
Context: Discoverability + power-user speed.
Recommendation: Type `/` in an empty composer opens the popover; also a command-palette entry (`Cmd/Ctrl+Shift+P` style) lists commands+skills.
ANSWER: ___

**Q10. Custom commands discovery.**
Context: `command.list()` returns custom + mcp + skill entries with a `source` field. This is the **V2 source of truth** — do not use any V1 TUI command list.
Recommendation: Surface **all** returned commands in the popover, badged by `source` (command / mcp / skill).
ANSWER: ___

**Q11. Skills presentation.**
Context: How do skills appear?
Recommendation: Inside the same `/` popover, badged "skill" (separate visual group), invoked via `session.skill`.
ANSWER: ___

**Q12. `@` file mention behavior.**
Context: Fuzzy find via `file.find`; what gets inserted?
Recommendation: Fuzzy ranked list; insert as a chip that carries file content/reference into `prompt.files`; support image files too (sent as attachment).
ANSWER: ___

### C. Forms (replace the question heuristic)

**Q13. Replace `isQuestion` heuristic entirely?**
Context: It's fragile (regex on assistant text).
Recommendation: Replace with real `form.*` in M6; keep heuristic only as a short-lived fallback until forms land.
ANSWER: ___

**Q14. Form field types to support first.**
Context: `FormFields` can be string/number/select/bool/etc.
Recommendation: string (incl. options), number, boolean, select; file later if needed.
ANSWER: ___

**Q15. Where does the FormCard render?**
Context: Mirrors the permission card pattern.
Recommendation: Inline in the feed (like permission cards), styled in our theme; posts via `form.reply`.
ANSWER: ___

### D. Events / streaming

**Q16. Event router shape.**
Context: Coarse prefix match today.
Recommendation: Explicit typed router (`Record<EventType, handler>`); additive, keeps `onResync` re-sync.
ANSWER: ___

**Q17. True delta streaming adoption.**
Context: Today = whole-list refetch every 120ms + 1500ms poll while busy.
Recommendation: Adopt `session.text.delta`/`reasoning.delta`/`tool.*` in M7, keep REST poll as fallback.
ANSWER: ___

**Q18. Must-wire vs nice-to-have events for first pass.**
Context: 100+ events; prioritize.
Recommendation: Wire ALL valuable events from §3.3 (the full list), not just a subset. The bullet list below was a first-pass priority ordering; implement the complete set.
ANSWER: Wire ALL valuable events from §3.3 (full list), not just the must-wire subset.

### E. Parity features priority (M7)

**Q19. Priority order of M7 parity items.**
Context: Export/import, undo/redo, connect in-app, init, vcs, worktrees, saved perms, queue/steer, context precise.
Recommendation: (1) connect in-app, (2) export/import, (3) undo/redo, (4) saved permissions, (5) queue/steer UI, (6) context precise, (7) init/instructions, (8) VCS, (9) worktrees.
ANSWER: ___

**Q20. Connect in-app flows.**
Context: `integration.connect.{key,oauth,command}`.
Recommendation: Support all three (key paste, OAuth, command) in the Providers drawer.
ANSWER: ___

**Q21. VCS scope.**
Context: `vcs.status` / `vcs.diff`.
Recommendation: Branch chip in header + diff viewer using `vcs.diff`; full status grid optional later.
ANSWER: ___

**Q22. Worktrees priority.**
Context: Lower user demand for a GUI sidebar.
Recommendation: IN SCOPE — include list/create/remove/refresh UI. Lowest-priority parity item, but not deferred/skipped (per review).
ANSWER: Include the worktree feature (list/create/remove/refresh UI). Lowest-priority parity item but IN SCOPE — do not skip.

### F. MCP / Providers

**Q23. MCP credential (secrets) management UI.**
Context: `credential.update/remove` exist; current add only takes a config object.
Recommendation: Add secret entry fields in the MCP add form; manage via credentials API.
ANSWER: ___

**Q24. Providers drawer: fully replace CLI handoff?**
Context: Today `opencode2 auth login` terminal handoff (also the binary bug).
Recommendation: Yes — replace with in-app connect flows (Q20); removes the binary dependency for auth.
ANSWER: ___

### G. Bugs / cleanup

**Q25. Binary-name bug fix timing.**
Context: `opencode2` vs `opencode` (§3.6.1).
Recommendation: Quick fix now (use `ResolvedCli.display`) — low risk, unblocks provider auth + terminal.
ANSWER: Confirmed — the V2 CLI binary is 'opencode2' (present on PATH). Fix uses ResolvedCli.display, which resolves to opencode2 here and also handles opencode-only installs. Your setup is unchanged.

**Q26. Stray `showTestQuestion` command.**
Context: Debug command shipped in production.
Recommendation: Remove it (or gate behind a debug setting).
ANSWER: ___

**Q27. `permissions.mode` vs server alignment.**
Context: Client-side auto-reply only today.
Recommendation: Investigate server permission model in M7; align `askFirst/autoAllow/deny` with it (and surface saved rules).
ANSWER: ___

### H. Testing / delivery

**Q28. Test strategy expansion.**
Context: 29/29 unit tests today (format + protocol guards).
Recommendation: Add unit tests for new rpc guards + adapter mapping; keep manual live smoke as the integration gate (no headless service in CI yet).
ANSWER: ___

**Q29. Versioning for the next drop.**
Context: Currently 0.2.37.
Recommendation: Bump to **0.3.0** for the theme + slash-command feature drop (or keep 0.2.x patch until theme lands — your call).
ANSWER: ___

**Q30. README accuracy.**
Context: README claims things not yet built (queue/steer, "follows VS Code theme").
Recommendation: Correct the README now to match reality (remove VS Code-theme claim, mark queue/steer as planned), then expand after M8.
ANSWER: ___

### I. GUI-first boundaries

**Q31. Explicit "do NOT copy from the desktop TUI" list.**
Context: Keep our own GUI identity.
Recommendation: No full-terminal aesthetic, no `$` prompts everywhere, no TUI keybind emulation; keep mono only for tool/shell output and micro-labels.
ANSWER: ___

---

## 6. Remediation plan (milestones)

> Architecture intact: **all new server I/O in `apiAdapter.ts`**, new RPC in `protocol.ts` + `rpc.ts`, new UI in `webview-src/`. Gate every milestone with `npm run typecheck` + `npm test`; update `todo.md`/`MEMORY.md`; commit (conventional); verify `graphify-out/` refresh. GUI-first + own-theme direction throughout.

### M-theme — Own theme system + later official OpenCode themes
- [ ] Rebrand the existing first-party `--oc2-*` token system: replace the hardcoded VS Code Dark+ palette values in `:root` with our brand palette (dark + light via `[data-theme]`); keep `data-density` + `accentTint` hooks. *(No `--vscode-*` to remove — verified 0 refs; Q1 obsolete as rip-out.)*
- [ ] Ship our default theme (dark + light). *(Q2/Q3)*
- [ ] Theme switcher UI (settings + overflow menu). *(Q7)*
- [ ] Later: add **official OpenCode themes** as static CSS presets (light/dark/high-contrast). *(Q6)*
- [ ] Verify every component under our theme + each official preset.

### M5 — Slash commands, skills & `@` mention (highest priority)  *(decided: inline `/` popover; scope = slash + skills + `@` only)*
- [ ] `apiAdapter`: `commands()`, `skills()`, `sessionCommand()`, `sessionSkill()` (wrap `client.command.list`, `client.skill.list`, `client.session.command`, `client.session.skill`).
- [ ] `protocol.ts`/`rpc.ts`: add `commands.list`, `skills.list`, `session.command`, `session.skill`; validate params.
- [ ] `Composer.tsx`: **inline `/` popover** (built-ins we support + custom `command.list()` + skills `skill.list()`, badged by source), `@` file-mention popover (`file.find`), optional `!` shell (deferred). *(Q8–Q12)*
- [ ] Wire: `/x` → `session.command`; `/skill y` → `session.skill`; `@file` → chip → `prompt.files`.
- [ ] Tests for new rpc guards + adapter mapping.

### M6 — Forms (replace the question heuristic)
- [ ] `apiAdapter`: `formsList()`, `formGet()`, `formReply()`, `formCancel()`; event handler for `form.created/replied/cancelled`.
- [ ] `App.tsx`/`Feed`: native `FormCard` rendering fields (string/number/select/bool) from `FormInfo`, posting via `form.reply`. Gate old `isQuestion` heuristic as fallback. *(Q13–Q15)*
- [ ] Remove/gate `showTestQuestion`. *(Q26)*

### M7 — Event router + streaming + parity features
- [ ] Explicit typed event router; wire `mcp.status.changed`, `integration.updated`, `config.updated`, `vcs.branch.updated`, `session.revert.*`, `session.compaction.*`, `command.updated`, `skill.updated`, `plugin.*`, `session.inbox.*`, `session.instructions.updated`. *(Q16/Q18)*
- [ ] True delta streaming (`session.text.delta`/`reasoning.delta`/`tool.*`) with REST poll fallback. *(Q17)*
- [ ] **Export/Import**: `session.export` (download .md) + `session.import`.
- [ ] **Undo/Redo**: `session.revert.stage`→`commit`/`clear` controls.
- [ ] **Connect in-app**: `integration.connect.{key,oauth,command}` in Providers drawer (replaces CLI handoff). *(Q20/Q24)*
- [ ] **Init/instructions**: `instructions.entry.*` editor.
- [ ] **VCS**: branch chip + `vcs.diff`/`vcs.status`. *(Q21)*
- [ ] **Worktrees**: list/create/remove/refresh UI — IN SCOPE (lowest-priority parity item, not skipped). *(Q22, included per review)*
- [ ] **Saved permissions**: `permission.saved.list/remove` manager; align `permissions.mode` with server. *(Q27)*
- [ ] **Context precise**: use `session.context`.
- [ ] **Queue/steer UI**: "while busy" chip to choose `delivery`.
- [ ] **Binary-name bug**: use `ResolvedCli.display` in `rpc.ts:145` and `extension.ts:90`. *(Q25)*
- [ ] MCP credential management UI. *(Q23)*

### M8 — Polish & completeness
- [ ] Render tool `file` parts (images) + user image attachments in history; handle/ignore the 8 meta message types. *(§3.4)*
- [ ] `file.read`/`file.list` for richer `@` mentions.
- [ ] `plugin.list`, `websearch.providers/query`, `project.current`, `config.get` surfaced where useful.
- [ ] `/share`+`/unshare` if server supports; `session.move` in session drawer.
- [ ] README correction + expansion. *(Q30)*
- [ ] Final typecheck + tests + build + vsix. *(Q29 version)*

---

## 7. Verification approach per milestone
1. `npm run typecheck` (host + webview) — gate.
2. `npm test` — new guards for rpc validation + adapter mapping.
3. `npm run build` + `vsce package`.
4. Live smoke against a running `opencode2`/`opencode` service: connect → slash `/command` runs → skill runs → `@` mention injects → form renders & replies → export downloads → undo/redo reverts files → provider connects in-app → event-driven MCP/integration refresh with no manual resync → theme switch (our theme + official presets) renders all components.
5. Update `todo.md` + `MEMORY.md`; commit; verify `graphify-out/` refreshed.
