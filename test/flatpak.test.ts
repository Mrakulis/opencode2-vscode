import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  flatpakHost,
  isFlatpak,
  isPosix,
  registrationFileForState,
  registrationFiles,
} from "../src/flatpak";

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

describe("registrationFiles", () => {
  const home = path.join("/", "home", "u");
  const canonical = registrationFileForState(
    path.join(home, ".local", "state"),
  );

  it("uses the env-based default outside Flatpak", () => {
    assert.deepEqual(registrationFiles({}, home, false), [canonical]);
  });

  it("prefers XDG_STATE_HOME when set outside Flatpak", () => {
    const xdg = path.join("/xdg", "state");
    assert.deepEqual(registrationFiles({ XDG_STATE_HOME: xdg }, home, false), [
      registrationFileForState(xdg),
      canonical,
    ]);
  });

  it("keeps the canonical host path first inside Flatpak", () => {
    assert.deepEqual(
      registrationFiles(
        { XDG_STATE_HOME: path.join(home, ".var/app/id/state") },
        home,
        true,
      ),
      [canonical, registrationFileForState(path.join(home, ".var/app/id/state"))],
    );
  });

  it("tries HOST_XDG_STATE_HOME before everything inside Flatpak", () => {
    assert.deepEqual(
      registrationFiles(
        {
          HOST_XDG_STATE_HOME: path.join("/host", "state"),
          XDG_STATE_HOME: path.join(home, ".var/app/id/state"),
        },
        home,
        true,
      ),
      [
        registrationFileForState(path.join("/host", "state")),
        canonical,
        registrationFileForState(path.join(home, ".var/app/id/state")),
      ],
    );
  });

  it("drops the sandbox candidate when it equals the canonical one", () => {
    assert.deepEqual(registrationFiles({}, home, true), [canonical]);
  });
});