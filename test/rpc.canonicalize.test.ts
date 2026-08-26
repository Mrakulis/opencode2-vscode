import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeDirectory } from "../src/directory";

/**
 * VERIFIED LIVE 2026-08-26: a lowercase drive letter in a session location
 * crashes the V2 server's instruction initializer — every prompt on such a
 * session fails silently (Instructions.InitializationBlocked).
 */
describe("canonicalizeDirectory", () => {
  it("uppercases a lowercase win32 drive letter", function () {
    if (process.platform !== "win32") this.skip();
    assert.equal(canonicalizeDirectory("e:\\_Code\\proj"), "E:\\_Code\\proj");
    assert.equal(canonicalizeDirectory("e:/_Code/proj"), "E:\\_Code\\proj");
  });
  it("leaves uppercase drives untouched", function () {
    if (process.platform !== "win32") this.skip();
    assert.equal(canonicalizeDirectory("E:\\_Code\\proj"), "E:\\_Code\\proj");
  });
  it("normalizes mixed separators", function () {
    if (process.platform !== "win32") this.skip();
    assert.equal(
      canonicalizeDirectory("e:/_Code/Opencode2 VS Code Extention"),
      "E:\\_Code\\Opencode2 VS Code Extention",
    );
  });
});
