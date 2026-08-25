import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Flatpak sandbox support.
 *
 * VS Code installed via Flatpak (Linux Mint et al.) runs the extension host
 * inside a sandbox: host binaries, filesystem paths, and PATH are isolated
 * from the real system. The standard escape hatch is `flatpak-spawn --host`,
 * which executes a command on the host system outside the sandbox. These pure
 * helpers detect the sandbox and build the escaped argv. This module must stay
 * free of the `vscode` import so it remains unit-testable in plain node.
 */

/** True when running inside a Flatpak sandbox. */
export function isFlatpak(): boolean {
  return (
    !!process.env.FLATPAK_ID ||
    fs.existsSync("/.flatpak-info") ||
    (fs.existsSync("/proc/self/mountinfo") &&
      fs.readFileSync("/proc/self/mountinfo", "utf8").includes("flatpak"))
  );
}

/** Prefix a host-execution command with the Flatpak sandbox escape. */
export function flatpakHost(args: string[]): string[] {
  return isFlatpak() ? ["flatpak-spawn", "--host", ...args] : args;
}

/** True when running on a POSIX platform (Linux/macOS). */
export function isPosix(): boolean {
  return process.platform !== "win32";
}

/** Absolute registration-file path for a state directory. */
export function registrationFileForState(stateDir: string): string {
  return path.join(stateDir, "opencode", "service.json");
}

/**
 * Service-registration file candidates to probe, best first.
 *
 * The client library computes its default as
 * `$XDG_STATE_HOME ?? ~/.local/state` — but Flatpak sandboxes override
 * `XDG_STATE_HOME` to `$HOME/.var/app/$ID/state` (Flatpak >= 1.13) while the
 * HOST-spawned service registers at the real `~/.local/state`. Under Flatpak
 * we therefore try Flatpak's own host-path escape hatch (`HOST_XDG_STATE_HOME`)
 * and the canonical home location before the sandbox-default one. Env/home/
 * sandbox are injectable so every branch is testable on any platform.
 */
export function registrationFiles(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  sandboxed: boolean = isFlatpak(),
): string[] {
  const canonical = registrationFileForState(
    path.join(home, ".local", "state"),
  );
  const envBased = registrationFileForState(
    env.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
  );
  const out: string[] = [];
  if (sandboxed) {
    if (env.HOST_XDG_STATE_HOME)
      out.push(registrationFileForState(env.HOST_XDG_STATE_HOME));
    out.push(canonical);
    if (envBased !== canonical) out.push(envBased);
  } else {
    out.push(envBased);
    if (canonical !== envBased) out.push(canonical);
  }
  return [...new Set(out)];
}