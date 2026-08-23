import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Log } from "./log";

/**
 * Resolves the OpenCode V2 CLI into something Node can actually spawn.
 *
 * Windows reality: npm installs `.cmd` shims that child_process refuses to
 * execute directly (EINVAL since the 2024 patch). We therefore resolve the
 * REAL binary behind the shim and fall back to `cmd /c <shim>` only when no
 * real binary exists.
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
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function run(program: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function isRealExe(p: string): boolean {
  return /\.exe$/i.test(p);
}

/** All PATH hits for a command name (shims and exes alike). */
function whereAll(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("where.exe", [name], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        stdout
          .toString()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      );
    });
  });
}

async function queryVersion(resolved: ResolvedCli): Promise<string | undefined> {
  try {
    const { stdout } = await run(resolved.program, [...resolved.prefixArgs, "--version"]);
    return stdout.trim().split(/\r?\n/, 1)[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Build a spawnable descriptor from any candidate file path. */
function describe(candidate: string): ResolvedCli | undefined {
  const expanded = expandHome(candidate);
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
  // .cmd / .bat shim -> route through cmd.exe
  if (/\.cmd$/i.test(expanded) || /\.bat$/i.test(expanded)) {
    return { program: "cmd.exe", prefixArgs: ["/d", "/c", expanded], display: expanded };
  }
  // extension-less shims (sh script) -> skip on Windows spawn paths
  return undefined;
}

/** Well-known real binaries shipped beside the npm packages. */
function knownRealExes(name: string): string[] {
  const npmRoot = path.join(process.env.APPDATA ?? "", "npm");
  const out: string[] = [];
  if (name === "opencode2" || name === "opencode") {
    out.push(
      path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe"),
      path.join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    );
  }
  return out;
}

/**
 * Resolve the OpenCode V2 CLI. Order:
 *  1. explicit `opencode2.cliPath`
 *  2. PATH hits for `opencode2`, preferring real exes over shims
 *  3. known real-exe locations derived from the npm layout
 *  4. PATH hits for legacy `opencode` (only useful for discovery-less spawn)
 */
export async function resolveCli(log: Log): Promise<ResolvedCli | undefined> {
  const configured = vscode.workspace.getConfiguration("opencode2").get<string>("cliPath", "").trim();
  const names: string[] = configured ? [configured] : [...CANDIDATE_NAMES];
  if (!configured) names.push("opencode");

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
          log.debug(`cli resolved (shim via ${d.program}): ${hit} (${version ?? "?"})`);
          return { ...d, version };
        }
      }
    }
    // real binaries living inside the npm package folders
    for (const exe of knownRealExes(name)) {
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

/** Spawn argv for an arbitrary CLI invocation (service subcommand appended). */
export function spawnArgv(cli: ResolvedCli, ...args: string[]): string[] {
  return [cli.program, ...cli.prefixArgs, ...args];
}

/** Install/update the OpenCode V2 CLI globally via npm. */
export async function installCli(log: Log): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Install/update the OpenCode V2 CLI globally via npm (opencode-ai@beta)?",
    "Install",
    "Cancel",
  );
  if (choice !== "Install") return;

  const terminal = vscode.window.createTerminal({ name: "OpenCode 2 — CLI install" });
  terminal.show();
  terminal.sendText("npm install -g opencode-ai@beta", true);
  log.info("npm global install started in terminal 'OpenCode 2 — CLI install'.");
}
