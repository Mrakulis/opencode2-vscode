import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { wellKnownCliLocations } from "../src/locations";

describe("wellKnownCliLocations", () => {
  it("ignores unrelated command names", () => {
    assert.deepEqual(wellKnownCliLocations("frobnicate"), []);
  });

  it("returns the Windows npm layout for win32", () => {
    const out = wellKnownCliLocations("opencode2", "win32");
    assert.ok(out.length >= 3);
    // real binaries + shim fallback for GUI-launched VS Code with minimal PATH
    assert.ok(out.some((p) => p.endsWith("opencode2.exe") && p.includes("node_modules")), out.join(", "));
    assert.ok(out.some((p) => p.endsWith("opencode2.cmd")), out.join(", "));
  });

  it("returns the Windows npm layout for the npm bin name too", () => {
    const out = wellKnownCliLocations("opencode", "win32");
    assert.ok(out.some((p) => p.endsWith("opencode.exe") && p.includes("node_modules")), out.join(", "));
    assert.ok(out.some((p) => p.endsWith("opencode.cmd")), out.join(", "));
  });

  it("covers user-prefix and system dirs on Linux", () => {
    const out = wellKnownCliLocations("opencode2", "linux");
    const home = os.homedir();
    const expected = [
      path.join(home, ".local", "bin", "opencode2"),
      path.join(home, ".npm-global", "bin", "opencode2"),
      path.join(home, ".opencode", "bin", "opencode2"),
      path.join(home, "bin", "opencode2"),
      path.join("/usr/local/bin", "opencode2"),
      path.join("/usr/bin", "opencode2"),
    ];
    assert.deepEqual(out, expected);
    for (const p of out) assert.ok(path.isAbsolute(p), p);
  });

  it("handles macOS with the same POSIX conventions", () => {
    const out = wellKnownCliLocations("opencode", "darwin");
    const home = os.homedir();
    assert.ok(out.includes(path.join(home, ".local", "bin", "opencode")));
  });
});