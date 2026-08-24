# Contributing

Thanks for your interest in contributing! This project is an independent VS Code sidebar client for [OpenCode](https://opencode.ai), built on the V2 API.

## Development

```sh
git clone https://github.com/Mrakulis/opencode2-vscode
cd opencode2-vscode
npm install
npm run build      # bundle extension + webview
```

Press **F5** in VS Code to launch an Extension Development Host (a running OpenCode CLI is required for live testing).

## Before opening a PR

```sh
npm run typecheck   # strict TS across host + webview — required
npm test            # unit tests — required
npm run audit       # rpc-surface consistency + theme tokens (for picker/theme/rpc changes)
npm run build       # must succeed
```

CI runs the same gates. Please keep PRs focused; one logical change per PR.

## Guidelines

- **V2 API only** — all OpenCode interaction goes through `@opencode-ai/client` / `src/apiAdapter.ts`. V1 TUI concepts and command names are out of scope.
- **Design language**: first-party `--oc2-*` theme tokens (see `webview-src/styles.css`) — no VS Code theme variables, no CSS framework.
- Keep new markdown files inside the repo root, minimal.
- Never commit secrets (`.env` is gitignored).

## Reporting bugs

Include: VS Code version, extension version, OpenCode CLI version (`opencode --version`), steps to reproduce, and relevant lines from the `OpenCode 2` output channel (enable `opencode2.debug.logs` first).
