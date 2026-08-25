import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { flatpakHost, isFlatpak, isPosix } from "../src/flatpak";

describe("flatpak helpers", () => {
  const original = process.env.FLATPAK_ID;

  afterEach(() => {
    if (original === undefined) delete process.env.FLATPAK_ID;
    else process.env.FLATPAK_ID = original;
  });

  it("detects a Flatpak sandbox via FLATPAK_ID", () => {
    process.env.FLATPAK_ID = "org.visualstudio.code";
    assert.equal(isFlatpak(), true);
  });

  it("is not a Flatpak sandbox outside one (dev machine)", () => {
    delete process.env.FLATPAK_ID;
    // Windows dev machines have neither /.flatpak-info nor /proc/self/mountinfo.
    assert.equal(isFlatpak(), false);
  });

  it("leaves host commands untouched outside Flatpak", () => {
    delete process.env.FLATPAK_ID;
    assert.deepEqual(flatpakHost(["opencode2", "serve"]), [
      "opencode2",
      "serve",
    ]);
  });

  it("escapes host commands with flatpak-spawn inside Flatpak", () => {
    process.env.FLATPAK_ID = "org.visualstudio.code";
    assert.deepEqual(
      flatpakHost(["/home/user/bin/opencode2", "serve", "--service"]),
      [
        "flatpak-spawn",
        "--host",
        "/home/user/bin/opencode2",
        "serve",
        "--service",
      ],
    );
  });

  it("isPosix reflects the platform", () => {
    assert.equal(isPosix(), process.platform !== "win32");
  });
});