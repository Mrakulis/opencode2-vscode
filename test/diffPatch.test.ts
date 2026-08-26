import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyUnifiedPatch,
  extractAddedContent,
  parseHunks,
} from "../src/diffPatch";

// Shape produced by the live V2 server for write/edit permissions
// (captured 2026-08-26 via scripts/perm-probe.mjs).
const ADDED_PATCH = [
  "Index: oc2-probe.txt",
  "===================================================================",
  "--- oc2-probe.txt",
  "+++ oc2-probe.txt",
  "@@ -0,0 +1,1 @@",
  "+hello",
  "\\ No newline at end of file",
].join("\n");

describe("parseHunks", () => {
  it("ignores preamble rows and no-newline markers", () => {
    const hunks = parseHunks(ADDED_PATCH);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]!.origStart, 0);
    assert.deepEqual(
      hunks[0]!.lines.map((l) => `${l.kind}${l.text}`),
      ["+hello"],
    );
  });
});

describe("applyUnifiedPatch", () => {
  it("applies an added-file patch to an empty original", () => {
    assert.equal(applyUnifiedPatch("", ADDED_PATCH), "hello");
  });

  it("applies a mid-file edit with context", () => {
    const original = ["one", "two", "three"].join("\n");
    const patch = [
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n");
    assert.equal(applyUnifiedPatch(original, patch), "one\nTWO\nthree");
  });

  it("returns undefined on context mismatch instead of guessing", () => {
    const patch = ["@@ -1,2 +1,2 @@", " one", "-WRONG", "+x"].join("\n");
    assert.equal(applyUnifiedPatch("one\ntwo", patch), undefined);
  });

  it("supports multiple sequential hunks and trailing context", () => {
    const original = ["a", "b", "c", "d", "e"].join("\n");
    const patch = [
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -4,2 +4,2 @@",
      " d",
      "-e",
      "+E",
    ].join("\n");
    assert.equal(applyUnifiedPatch(original, patch), "a\nB\nc\nd\nE");
  });
});

describe("extractAddedContent", () => {
  it("joins plus lines of an added file", () => {
    assert.equal(extractAddedContent(ADDED_PATCH), "hello");
  });
});
