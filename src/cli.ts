import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { isFlatpak, isPosix } from "./flatpak";
import { wellKnownCliLocations } from "./locations";
import { Log } from "./log";

/**
 * Resolves the OpenCode V2 CLI into something Node can actually spawn.
 *
 * Windows reality: npm installs `.cmd` shims that child_process refuses to
 * execute directly (EINVAL since the 2024 patch). We resolve the REAL binary
 * behind the shim and fall back to `cmd /c <shim>` only when no real binary
 * exists.
 *
 * Flatpak reality: VS Code running as a Flatpak is sandboxed — host binaries,
 * filesystem paths, and PATH are all isolated. We detect the sandbox and
 * escape it with `flatpak-spawn --host` so the CLI is found and runs on the
 * host system where it was installed.
 */
export interface ResolvedCli {
  /** Absolute program to spawn (an .exe, or cmd.exe for shim fallback). */
  readonly program: string;
  /** Arguments inserted before the service subcommand. */
  readonly prefixArgs: string[];
  /** Human-friendly command for terminals/status display. */
  readonly display: string;
  readonly version?: string;
}

const CANDIDATE_NAMES = ["opencode2", "opencode"] as const;

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return path.join(os.homedir(), p.slice(2));
  return p;
}

function run(
  program: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: 10_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

/** Wrapped/escaped run for host commands (Flatpak-aware). */
function runHost(
  program: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return isFlatpak()
    ? run("flatpak-spawn", ["--host", program, ...args])
    : run(program, args);
}

function isRealExe(p: string): boolean {
  return /\.exe$/i.test(p);
}

/** All PATH hits for a command name (cross-platform, Flatpak-aware). */
function whereAll(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    if (!isPosix()) {
      execFile(
        "where.exe",
        [name],
        { windowsHide: true, timeout: 10_000 },
        (error, stdout) => {
          if (error) return resolve([]);
          resolve(
            stdout
              .toString()
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l.length > 0),
          );
        },
      );
      return;
    }
    // POSIX: prefer host lookup when sandboxed; otherwise local shell.
    const probe = isFlatpak()
      ? ["flatpak-spawn", "--host", "sh", "-lc", `command -v -a ${name}`]
      : ["sh", "-lc", `command -v -a ${name}`];
    execFile(
      probe[0]!,
      probe.slice(1),
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        if (error) return resolve([]);
        resolve(
          stdout
            .toString()
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        );
      },
    );
  });
}

async function queryVersion(
  resolved: ResolvedCli,
): Promise<string | undefined> {
  try {
    const { stdout } = await runHost(resolved.program, [
      ...resolved.prefixArgs,
      "--version",
    ]);
    return stdout.trim().split(/\r?\n/, 1)[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Build a spawnable descriptor from any candidate file path. */
function describe(candidate: string): ResolvedCli | undefined {
  const expanded = expandHome(candidate);
  // In Flatpak we cannot stat host paths directly; existence was already
  // validated via the host `command -v`. Return the host path as-is and let
  // flatpak-spawn handle execution.
  if (isFlatpak()) {
    return expanded ? { program: expanded, prefixArgs: [], display: expanded } : undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(expanded);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;

  if (isRealExe(expanded)) {
    return { program: expanded, prefixArgs: [], display: expanded };
  }
  // .cmd / .bat shim -> route through cmd.exe. Prefer a sibling .exe
  // when it exists — spawning node/.exe directly is truly hidden (CREATE_NO_WINDOW
  // fully suppresses conhost), while cmd.exe can still flash briefly. This
  // mirrors wellKnownCliLocations prioritization but also handles PATH hits.
  if (/\.cmd$/i.test(expanded) || /\.bat$/i.test(expanded)) {
    const siblingExe = expanded.replace(/\.(cmd|bat)$/i, ".exe");
    try {
      const s = fs.statSync(siblingExe);
      if (s.isFile()) {
        return { program: siblingExe, prefixArgs: [], display: siblingExe };
      }
    } catch {
      /* no sibling exe — fall through to cmd wrapper */
    }
    // No sibling exe — try to parse shim and spawn node directly to avoid
    // cmd.exe flash. npm shims are `@"%~dp0\node.exe" "%~dp0\node_modules\...\bin\..." %*`
    // Fallback to cmd.exe only if parsing fails.
    try {
      const content = fs.readFileSync(expanded, "utf8");
      // Extract quoted target like "%~dp0\node_modules\opencode-ai\bin\opencode"
      const m = content.match(/"%~dp0\\([^"]+)"/);
      if (m?.[1]) {
        const shimDir = path.dirname(expanded);
        const target = path.join(shimDir, m[1].replace(/\//g, path.sep));
        try {
          const ts = fs.statSync(target);
          if (ts.isFile()) {
            // Find node.exe that the shim would have used (%~dp0\node.exe)
            const nodeExe = path.join(shimDir, "node.exe");
            let nodeProg: string | undefined;
            try {
              if (fs.statSync(nodeExe).isFile()) nodeProg = nodeExe;
            } catch {
              /* no bundled node — use PATH node */
            }
            // If we have a JS file, spawn via node directly for true hidden start
            if (/\.js$/i.test(target) || !/\.exe$/i.test(target)) {
              const node = nodeProg ?? "node";
              return { program: node, prefixArgs: [target], display: expanded };
            }
            return { program: target, prefixArgs: [], display: expanded };
          }
        } catch {
          /* target not found */
        }
      }
    } catch {
      /* read failed — fall through */
    }
    return {
      program: "cmd.exe",
      // /d = no AutoRun, /s = handle quoted command correctly, /c = run then terminate
      // Quoting the shim path handles spaces in APPDATA; /s ensures the quotes are stripped correctly
      prefixArgs: ["/d", "/s", "/c", `"${expanded}"`],
      display: expanded,
    };
  }
  // POSIX: resolved binaries are extension-less (ELF or shebang script) and
  // node spawns them natively. Require the exec bit so random same-named
  // files don't pass; the old unconditional rejection here made CLI
  // resolution impossible everywhere off-Windows.
  if (isPosix()) {
    try {
      fs.accessSync(expanded, fs.constants.X_OK);
    } catch {
      return undefined;
    }
    return { program: expanded, prefixArgs: [], display: expanded };
  }
  // Windows leftovers that are neither exe nor cmd/bat shims: unusable.
  return undefined;
}

/**
 * Resolve the OpenCode V2 CLI. Order:
 *  1. explicit `opencode2.cliPath`
 *  2. PATH hits for `opencode2`, preferring real exes over shims
 *  3. well-known install locations (npm layout on Windows; `~/.local/bin`,
 *     `~/.npm-global/bin`, `~/.opencode/bin`, `~/bin`, `/usr/local/bin`,
 *     `/usr/bin` on POSIX — covers installs a GUI-launched editor's PATH
 *     never sees)
 *  4. PATH hits for legacy `opencode` (only useful for discovery-less spawn)
 */
export async function resolveCli(log: Log): Promise<ResolvedCli | undefined> {
  const configured = vscode.workspace
    .getConfiguration("opencode2")
    .get<string>("cliPath", "")
    .trim();
  const names: string[] = configured
    ? [configured]
    : [...new Set<string>([...CANDIDATE_NAMES, "opencode"])];

  for (const name of names) {
    const found = await whereAll(name);
    // prefer real exes over shims within PATH hits
    for (const hit of found.filter(isRealExe)) {
      const d = describe(hit);
      if (d) {
        const version = await queryVersion(d);
        if (version !== undefined) {
          log.debug(`cli resolved (exe): ${d.program} (${version})`);
          return { ...d, version };
        }
      }
    }
    for (const hit of found.filter((h) => !isRealExe(h))) {
      const d = describe(hit);
      if (d) {
        const version = await queryVersion(d);
        if (version !== undefined) {
          log.debug(
            `cli resolved (shim via ${d.program}): ${hit} (${version ?? "?"})`,
          );
          return { ...d, version };
        }
      }
    }
    // well-known install locations the build may have dropped the CLI into
    for (const exe of wellKnownCliLocations(name)) {
      const d = describe(exe);
      if (d) {
        const version = await queryVersion(d);
        if (version !== undefined) {
          log.debug(`cli resolved (known location): ${d.program} (${version})`);
          return { ...d, version };
        }
      }
    }
    if (configured) break; // explicit path was tried; do not fall back silently
  }

  log.warn("no usable OpenCode CLI found");
  return undefined;
}

/** Spawn argv for an arbitrary CLI invocation, escaping Flatpak if needed. */
export function spawnArgvHost(cli: ResolvedCli, ...args: string[]): string[] {
  const base = [cli.program, ...cli.prefixArgs, ...args];
  return isFlatpak() ? ["flatpak-spawn", "--host", ...base] : base;
}

/** Install/update the OpenCode V2 CLI globally via npm. */
export async function installCli(log: Log): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Install/update the OpenCode V2 CLI globally via npm (opencode-ai@beta)?",
    "Install",
    "Cancel",
  );
  if (choice !== "Install") return;

  const terminal = vscode.window.createTerminal({
    name: "OpenCode 2 — CLI install",
  });
  terminal.show();
  // Under Flatpak the integrated terminal runs inside the sandbox, where an
  // npm -g install is invisible to our host-side resolution — escape it.
  const installCmd = isFlatpak()
    ? "flatpak-spawn --host bash -lc 'npm install -g opencode-ai@beta'"
    : "npm install -g opencode-ai@beta";
  terminal.sendText(installCmd, true);
  log.info("npm global install started in terminal 'OpenCode 2 — CLI install'.");
}