# OpenCode 2 for VS Code

A VS Code sidebar client for [OpenCode](https://opencode.ai), built natively on the **OpenCode V2 API** (`@opencode-ai/client`) and designed around what V2 makes possible and how VS Code itself behaves.

## Features

- **Native sidebar chat** with an agent that reads and edits your code
- **Auto-connects** to OpenCode V2's shared background service (no ports, no manual `serve`)
- **Live streaming** responses with reasoning blocks, tool cards, and inline diffs
- **Session management**: search, switch, rename (double-click title), delete, fork
- **Agent controls**: per-session model & agent switching without restarts
- **Permission approvals** inline (allow once / always / deny)
- **Cost, token and context telemetry** with an optional auto-compact threshold
- **Queue or steer** follow-ups while the agent is working
- **Theme-native**: follows your VS Code theme exactly; compact/comfortable density

## Requirements

- VS Code 1.96+
- An OpenCode V2 CLI (`opencode2`) installed locally. The extension can install it via the command palette (`OpenCode 2: Install CLI`).

## Getting started

1. Open a workspace folder.
2. Click the OpenCode icon in the activity bar.
3. The extension discovers your running OpenCode service (or starts one).
4. Type a prompt.

## Commands

| Command | Description |
|---|---|
| `OpenCode 2: Focus Sidebar` | Focus the OpenCode view |
| `OpenCode 2: Toggle Sidebar` | Open/close the sidebar |
| `OpenCode 2: New Session` | Create and select a fresh session |
| `OpenCode 2: Refresh` | Reconnect + resync |
| `OpenCode 2: Restart Background Service` | Force a new service connection |
| `OpenCode 2: Open Terminal` | Launch the CLI in a terminal |
| `OpenCode 2: Install CLI` | Install/update via npm (`opencode-ai@beta`) |

## Settings (`opencode2.*`)

| Setting | Default | Description |
|---|---|---|
| `server.baseUrl` | `""` | Explicit server URL; empty = auto-discover/start |
| `server.autoStart` | `true` | Start the shared service when none is running |
| `cliPath` | `""` | Custom CLI path; empty = try `opencode2` then `opencode` |
| `debug.logs` | `false` | Verbose logging in the output channel |
| `ui.density` | `compact` | `compact` / `comfortable` |
| `ui.accentTint` | `off` | Optional accent color tint |
| `ui.sounds` | `true` | Subtle chimes on finish/permission |
| `ui.showReasoning` | `collapsed` | Reasoning blocks: hide / collapsed / expanded |
| `ui.expandShellTools` | `false` | Shell tool cards expanded by default |
| `ui.expandEditTools` | `false` | Edit/diff tool cards expanded by default |
| `ui.messageStats` | `true` | Per-message token/cost badges |
| `composer.sendKey` | `enter` | enter / ctrlEnter to send |
| `models.hidden` | `[]` | Models hidden from the picker (`providerID/modelID`) |
| `models.favorites` | `[]` | Starred models pinned to picker top |
| `models.default` | `` | Default model for new sessions (`providerID/modelID`) |
| `notifications.errors` | `false` | Failed-run notifications |
| `agent.autoCompactThreshold` | `0` | Percent of context that triggers auto-compact |

## Workspaces

Open a folder, and every **new** session is anchored to it — the agent reads/edits inside that directory, exactly like running `opencode2` from a terminal already cd'd there. The header shows the bound folder as a chip. The sessions drawer defaults to the same scope; flip `this folder` ⇄ `all projects` to see history across projects. (Under the hood: one shared background service per machine; each session carries its own directory anchor.)

## Development

```sh
npm install
npm run typecheck   # strict TS across host + webview
npm test            # unit tests
npm run build       # bundle extension + webview
npm run watch
```

Press F5 to launch an Extension Development Host.

## Architecture notes

All server I/O lives in the extension host (`src/controller.ts`, all client calls isolated in `src/apiAdapter.ts`). The React webview communicates over a typed postMessage RPC bridge (`src/protocol.ts`). The `/api/event` stream is treated as volatile by contract: every reconnect triggers a REST re-sync. See `plan.md` for the full design.

## License

MIT
