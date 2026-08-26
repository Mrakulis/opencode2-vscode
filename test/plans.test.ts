import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nextTask,
  parsePlanTasks,
  setTaskStatus,
} from "../webview-src/lib/plans";

const DOC = [
  "# Plan",
  "",
  "- [x] scaffold project",
  "- [/] wire the parser",
  "  - [ ] nested sub item stays a task",
  "- [ ] ship it",
  "not a task line",
  "* [X] asterisk bullet uppercase",
].join("\n");

describe("parsePlanTasks", () => {
  it("parses open/done/inprogress items with their line indexes", () => {
    const tasks = parsePlanTasks(DOC);
    assert.deepEqual(
      tasks.map((t) => [t.line, t.status, t.title]),
      [
        [2, "done", "scaffold project"],
        [3, "inprogress", "wire the parser"],
        [4, "open", "nested sub item stays a task"],
        [5, "open", "ship it"],
        [7, "done", "asterisk bullet uppercase"],
      ],
    );
  });
});

describe("setTaskStatus", () => {
  it("rewrites only the target checkbox, preserving indentation and text", () => {
    const out = setTaskStatus(DOC, 5, "inprogress");
    assert.ok(out.includes("- [/] ship it"));
    assert.ok(out.includes("- [x] scaffold project"));
    assert.equal(out.split("\n").length, DOC.split("\n").length);
  });
  it("clears a done task back to open", () => {
    const out = setTaskStatus(DOC, 2, "open");
    assert.ok(out.includes("- [ ] scaffold project"));
  });
});

describe("nextTask", () => {
  it("prefers in-progress over open", () => {
    const tasks = parsePlanTasks(DOC);
    assert.equal(nextTask(tasks)?.title, "wire the parser");
  });
});
