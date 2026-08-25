import * as fs from "node:fs";

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