import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Log } from "./log";

const CANDIDATE_BINARIES = ["opencode2", "opencode"] as const;

/** Result of resolving the OpenCode CLI on this machine. */
export interface ResolvedCli {
  /** Command name or absolute path suitable for spawning / terminals. */
  readonly command: string;
  /** Version string reported by the binary, when it could be queried. */
  readonly version?: string;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

async function queryVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(command, ["--version"]);
    return stdout.trim().split(/\r?\n/, 1)[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the OpenCode CLI: explicit `opencode2.cliPath` first, then the V2
 * binary name (`opencode2`), falling back to the legacy name (`opencode`).
 */
export async function resolveCli(log: Log): Promise<ResolvedCli | undefined> {
  const configured = vscode.workspace.getConfiguration("opencode2").get<string>("cliPath", "").trim();
  const candidates: string[] = [];
  if (configured) candidates.push(expandHome(configured));
  else candidates.push(...CANDIDATE_BINARIES);

  for (const candidate of candidates) {
    const version = await queryVersion(candidate);
    if (version !== undefined) {
      log.debug(`cli resolved: ${candidate} (${version})`);
      return { command: candidate, version };
    }
    log.debug(`cli candidate unusable: ${candidate}`);
  }
  return undefined;
}

/**
 * Install/update the OpenCode V2 CLI via npm (`opencode-ai@beta`).
 * Runs in a visible terminal so the user can watch and own any prompts.
 */
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
