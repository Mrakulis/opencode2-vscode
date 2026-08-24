import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { synthEditDiff, synthWriteDiff } from "../webview-src/lib/difftext";

describe("synthEditDiff", () => {
  it("marks removed lines then added lines for a replacement", () => {
    const d = synthEditDiff("const a = 1;", "const a = 2;");
    assert.deepEqual(d.split("\n"), ["-const a = 1;", "+const a = 2;"]);
  });
  it("trims common prefix/suffix so only the changed middle shows", () => {
    const old = ["a", "b", "OLD1", "d"].join("\n");
    const neu = ["a", "b", "NEW1", "NEW2", "d"].join("\n");
    const d = synthEditDiff(old, neu);
    assert.deepEqual(d.split("\n"), ["-OLD1", "+NEW1", "+NEW2"]);
  });
  it("returns empty string when texts are identical", () => {
    assert.equal(synthEditDiff("same\nlines", "same\nlines"), "");
  });
  it("handles pure insertion and deletion", () => {
    assert.deepEqual(synthEditDiff("", "x").split("\n"), ["+x"]);
    assert.deepEqual(synthEditDiff("x", "").split("\n"), ["-x"]);
  });
  it("truncates very large diffs", () => {
    const old = Array.from({ length: 900 }, (_, i) => `o${i}`).join("\n");
    const neu = Array.from({ length: 900 }, (_, i) => `n${i}`).join("\n");
    const lines = synthEditDiff(old, neu, 400).split("\n");
    assert.equal(lines.length, 401);
    assert.match(lines[400]!, /truncated/);
  });
});

describe("synthWriteDiff", () => {
  it("shows every line as added", () => {
    assert.deepEqual(synthWriteDiff("l1\nl2").split("\n"), ["+l1", "+l2"]);
  });
  it("returns empty for empty content", () => {
    assert.equal(synthWriteDiff(""), "");
  });
});
