# OpenCode 2 for VS Code

<p align="center">
  <a href="https://github.com/sponsors/Mrakulis"><img alt="Sponsor Mrakulis" src="https://img.shields.io/badge/sponsor-Mrakulis-4A3796?style=flat"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3F7FB3?style=flat">
</p>

> **Independent project · experimental.** Not affiliated with, endorsed by, or maintained by the OpenCode team ([Anomaly](https://github.com/anomalyco/opencode)). Built on the public **OpenCode V2 API**, which moves fast on the `beta` channel. Treat this client as a work in progress: individual features may break or lag behind upstream between beta builds.

A VS Code sidebar GUI client for [OpenCode](https://opencode.ai) — designed GUI-first (not a terminal clone), with full V2 API coverage: slash commands, skills, `@` file mentions, forms, worktrees, undo/redo with file reversion, and more.

## Features

- **Native sidebar chat** with an agent that reads and edits your code
- **Auto-connects** to the shared V2 background service (discover → hidden auto-start, no ports to manage)
- **Live streaming** — incremental text/reasoning deltas plus tool cards and inline diffs
- **Slash commands & skills** — type `/` for the V2 command catalog (`command.list`), skills included; runs via `session.command` / `session.skill`
- **`@` file mentions** — fuzzy file picker backed by `file.find`; files attach as prompt context
- **Agent forms** — structured input requests render as native cards (V2 `form.*`)
- **Session management**: search, switch, rename (double-click title), delete, fork
- **Agent controls**: per-session model & agent switching without restarts
- **Permission approvals** inline (allow once / always / deny) + a saved-rules manager
- **Undo / Redo** a turn with Git-backed file reversion (V2 `session.revert.*`)
- **Export / import** sessions in the V2 transfer format (JSON)
- **Worktrees** manager (list / create / remove) via `worktree.*`
- **Project instructions** editor (`instructions.entry.*`) — the GUI home of `/init`
- **MCP drawer** with live status; auto-refreshes on `mcp.status.changed`
- **Providers drawer** with in-app connect: API key or OAuth browser flow
- **Cost, token and context telemetry** with an optional auto-compact threshold
- **Queue or steer** follow-ups while the agent is working (composer chip)
- **Pre-apply diff review** — proposed edits show as native side-by-side diffs (with +N/−N counts) *before* anything is written; aggregated "Proposed changes" strip while approvals are pending
- **Smart model repair** — if a session's model keeps failing, Retry switches to a validated working model automatically and tells you why
- **Subagent inspector** — child runs appear as clickable chips with a live tail, token/cost summary, and a Terminate control
- **Code Mode visualizer** — sandboxed `execute` tool calls render as highlighted code blocks with a live tool-call timeline and a separate output pane; per-server Code Mode toggle in the MCP drawer
- **Plan checklist** (`⋯` menu) — interactive `implementation_plan.md` checklist with a "Run Next Task" prompt button
- **Resilient connection** — reconnects with backoff + full resync; a non-blocking banner offers Restart Background Service during drops; last-open session is restored after reloads
- **Session awareness** — unread dots on sessions that finished while you weren't looking (server-tracked `idle`/`viewed`, clears on open and syncs to other windows/TUI), plus a pulsing indicator for sessions running in another client window (`session.active`)
- **Auto-title (opt-in)** — after a session's first completed turn, a short title is generated (`session.generate`) and applied — unless you named it yourself
- **Usage & stats drawer** — global totals across all projects: tokens, cost, day streak, activity bars, per-model spend and tool reliability; open via the status-strip counters or `⋯` → `Usage…`
- **Own theme system** — OpenCode Dark & Light plus Tokyo Night, Gruvbox, Nord and Catppuccin presets (cycle from the `⋯` menu or pick in settings); compact/comfortable density

## Requirements

- VS Code 1.96+
- An OpenCode V2 CLI installed locally (`opencode2`, or `opencode` from npm). The extension can install it via the command palette (`OpenCode 2: Install CLI`).

> **Flatpak (Linux)** — VS Code installed as a Flatpak runs the extension host in a sandbox where host binaries and PATH are invisible. The extension detects the sandbox and escapes it automatically with `flatpak-spawn --host`, so make sure the CLI is installed **on the host system** (e.g. `sudo npm install -g opencode-ai@beta`), not inside the sandbox. The `OpenCode 2: Restart Background Service` command will surface a message pointing at host install if the CLI cannot be found. If the service starts but never connects, grant home/filesystem access to the Flatpak: `flatpak override --user --filesystem=home com.visualstudio.code`.

### Version compatibility

The extension is developed and tested against a specific client pin (`@opencode-ai/client` in `package.json`) — currently aligned with server **beta-18230**. Because OpenCode itself moves fast on the beta channel:

- Newer/older server betas generally work — all API access goes through a defensive adapter layer that normalizes known shape drift, and missing optional features degrade quietly.
- Explicit server `deny` rules are always enforced by the server regardless of extension version.
- CI includes a non-blocking **beta-drift canary** that runs the gates against the floating `@beta` client; when it goes red we re-pin and adapt.
- If something breaks after a CLI update: check the `OpenCode 2` output channel, and try `OpenCode 2: Restart Background Service` first.

## Getting started

1. Open a workspace folder.
2. Click the OpenCode icon in the activity bar.
3. The extension discovers your running OpenCode service (or starts one).
4. Type a prompt — or `/` for commands, `@` to attach a file.

## Commands

| Command | Description |
|---|---|
| `OpenCode 2: Focus Sidebar` | Focus the OpenCode view |
| `OpenCode 2: Toggle Sidebar` | Open/close the sidebar |
| `OpenCode 2: New Session` | Create and select a fresh session |
| `OpenCode 2: Refresh` | Reconnect + resync |
| `OpenCode 2: Restart Background Service` | Force a new service connection |
| `OpenCode 2: Open Terminal` | Launch the CLI in a terminal |
| `OpenCode 2: Install CLI` | Install/update via npm |

## Settings (`opencode2.*`)

| Setting | Default | Description |
|---|---|---|
| `server.baseUrl` | `""` | Explicit server URL; empty = use `server.mode` |
| `server.mode` | `own` | `own` (start our own hidden service) / `discover` (find an already-running one) |
| `server.autoStart` | `true` | Start a shared background service automatically when discovery finds nothing healthy |
| `cliPath` | `""` | Custom CLI path; empty = try `opencode2` then `opencode` |
| `debug.logs` | `false` | Verbose logging in the output channel |
| `ui.theme` | `dark` | Theme preset: dark, light, tokyonight, gruvbox, nord, catppuccin |
| `ui.density` | `compact` | `compact` / `comfortable` |
| `ui.accentTint` | `off` | Optional accent color tint |
| `ui.sounds` | `true` | Subtle chimes on finish/permission |
| `ui.showReasoning` | `collapsed` | Reasoning blocks: hide / collapsed / expanded |
| `ui.expandShellTools` | `false` | Shell tool cards expanded by default |
| `ui.expandEditTools` | `false` | Edit/diff tool cards expanded by default |
| `ui.fullShellOutput` | `false` | Show full shell output without truncation |
| `ui.messageStats` | `true` | Per-message token/cost badges |
| `composer.sendKey` | `enter` | enter / ctrlEnter to send |
| `models.hidden` | `[]` | Models hidden from the picker (`providerID/modelID`) |
| `models.favorites` | `[]` | Starred models pinned to picker top |
| `models.default` | `opencode/big-pickle` | Default model for new sessions (`providerID/modelID`). Validated against the catalog at creation; falls back to the first free OpenCode Zen model if it leaves the catalog. Empty = server default (not recommended — a broken server default silently kills new sessions) |
| `notifications.permissions` | `true` | Permission-request notifications |
| `notifications.agentEvents` | `true` | Agent finished notifications |
| `notifications.errors` | `false` | Failed-run notifications |
| `permissions.mode` | `askFirst` | Ask first / Auto allow / Deny |
| `agent.autoCompactThreshold` | `0` | Percent of context that triggers auto-compact |
| `sessions.autoTitle` | `false` | Auto-generate a title after a session's first completed turn (spends provider tokens; manual renames are never overridden) |

## Workspaces

Open a folder, and every **new** session is anchored to it — the agent reads/edits inside that directory, exactly like running the CLI from a terminal already cd'd there. The header shows the bound folder as a chip (plus the git branch when available). The sessions drawer defaults to the same scope; flip `this folder` ⇄ `all projects` to see history across projects.

## Architecture notes

All server I/O lives in the extension host (`src/controller.ts`; every client call isolated in `src/apiAdapter.ts`). The React webview communicates over a typed postMessage RPC bridge (`src/protocol.ts`). Incoming V2 events route through an explicit table (`webview-src/lib/events.ts`); text/reasoning deltas stream incrementally (`webview-src/lib/deltas.ts`) with REST re-sync as the volatile-stream safety net.

**Shared background service.** OpenCode V2's service is deliberately shared: sessions, config, plugins and permissions live in the service, not in a window. All extension windows (and the TUI) therefore connect to *one* discovered, authenticated service per machine — the extension reuses any healthy registration before spawning its own hidden one. There is intentionally **no workspace-scoped port locking**: lockfiles would strand sessions owned by other windows. A stale registration fails its health probe and the extension spawns fresh instead.

## Contributing & releasing

```sh
git clone https://github.com/Mrakulis/opencode2-vscode
cd opencode2-vscode
npm install
npm run typecheck   # strict TS across host + webview — required
npm test            # unit tests
npm run build       # bundle extension + webview
npm run watch       # rebuild on change
```

Press F5 to launch an Extension Development Host. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Releases (maintainer):** bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z` — CI gates, builds the vsix, creates a GitHub Release with it, and publishes to the Marketplace when the `VSCE_PAT` secret is configured (Azure DevOps PAT with *Marketplace → Manage* scope for publisher `Mrakulis`).

## License

MIT
