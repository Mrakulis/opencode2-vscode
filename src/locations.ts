import * as os from "node:os";
import * as path from "node:path";

/**
 * Well-known install locations for the OpenCode CLI binary, per platform.
 *
 * PATH search (`command -v -a`) misses CLI's installed in user-prefix or
 * script-installer directories that a GUI-launched editor never inherits
 * (launchers give the app a minimal PATH; shell profile exports don't apply).
 * These fallbacks cover the common Linux/macOS locations in addition to the
 * Windows npm layout.
 *
 * Kept free of the `vscode` import so it stays unit-testable in plain node.
 * The platform is injectable so every branch is testable on any machine.
 */
export function wellKnownCliLocations(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (name !== "opencode2" && name !== "opencode") return [];
  const bin = platform === "win32" ? `${name}.exe` : name;
  const out: string[] = [];

  if (platform === "win32") {
    // npm layout under %APPDATA%\npm — where `npm i -g opencode-ai@beta`
    // drops the real binaries next to the cmd shims. GUI-launched VS Code
    // often has a minimal PATH without %APPDATA%\npm, so we must probe
    // both the real binaries and the shim fallback. Prefer real exes — the
    // shim path via cmd.exe can still flash a conhost window despite
    // windowsHide (see src/controller.ts startHiddenService).
    const npmRoot = path.join(process.env.APPDATA ?? "", "npm");
    out.push(
      // Direct npm bin (real exe when npm creates it, or shim-adjacent)
      path.join(npmRoot, `${name}.exe`),
      path.join(npmRoot, `${name}.cmd`),
      // Package-internal binaries (both package names, both exe + extensionless)
      path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", `${name}.exe`),
      path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", name),
      path.join(npmRoot, "node_modules", "opencode-ai", "bin", `${name}.exe`),
      path.join(npmRoot, "node_modules", "opencode-ai", "bin", name),
      // Legacy/alternate exe names at package roots (covers different npm versions)
      path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", bin),
      path.join(npmRoot, "node_modules", "opencode-ai", "bin", bin),
    );
    // Deduplicate while preserving order
    return [...new Set(out)];
  }

  // POSIX: user installs (bare ~/bin, XDG ~/.local/bin, npm user prefix
  // ~/.npm-global, the opencode installer's ~/.opencode) then system dirs.
  const home = os.homedir();
  out.push(
    path.join(home, ".local", "bin", bin),
    path.join(home, ".npm-global", "bin", bin),
    path.join(home, ".opencode", "bin", bin),
    path.join(home, "bin", bin),
    path.join("/usr/local/bin", bin),
    path.join("/usr/bin", bin),
  );
  return out;
}