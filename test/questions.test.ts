import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isParkedQuestionPart,
  isTerminalQuestionPart,
  parseQuestionInput,
} from "../webview-src/lib/questions";

describe("parseQuestionInput", () => {
  it("parses the object shape (running/completed state)", () => {
    const items = parseQuestionInput({
      questions: [
        { header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "default" }] },
        { question: "ORM?" },
      ],
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].header, "DB");
    assert.equal(items[1].question, "ORM?");
  });

  it("parses the raw JSON string emitted while streaming", () => {
    const raw = JSON.stringify({ questions: [{ header: "OS", options: [{ label: "Linux" }, { label: "Windows" }] }] });
    const items = parseQuestionInput(raw);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].options?.map((o) => o.label), ["Linux", "Windows"]);
  });

  it("returns [] for garbage, missing questions and wrong shapes", () => {
    for (const bad of [undefined, null, 42, "not json", "", {}, { questions: "x" }, { questions: 5 }, []]) {
      assert.deepEqual(parseQuestionInput(bad), [], JSON.stringify(bad));
    }
  });

  it("drops non-object question entries", () => {
    const items = parseQuestionInput({ questions: [{ header: "ok" }, "junk", null, ["nested"]] });
    assert.equal(items.length, 1);
    assert.equal(items[0].header, "ok");
  });
});

describe("isParkedQuestionPart", () => {
  const part = (over: Record<string, unknown>) => ({
    type: "tool",
    name: "question",
    id: "call_1",
    state: { status: "running", input: {} },
    ...over,
  });

  it("matches live running/streaming questions by tool call id", () => {
    assert.equal(isParkedQuestionPart(part({})), "call_1");
    assert.equal(
      isParkedQuestionPart(part({ state: { status: "streaming" } })),
      "call_1",
    );
  });

  it("rejects terminal states, other tools and malformed parts", () => {
    for (const bad of [
      part({ state: { status: "completed" } }),
      part({ state: { status: "error" } }),
      part({ state: {} }),
      part({ name: "shell" }),
      part({ type: "text" }),
      part({ id: undefined }),
      null,
      undefined,
      "question",
    ]) {
      assert.equal(isParkedQuestionPart(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("isTerminalQuestionPart", () => {
  const part = (over: Record<string, unknown>) => ({
    type: "tool",
    name: "question",
    id: "call_9",
    state: { status: "error", input: {} },
    ...over,
  });

  it("matches dead questions (error/completed/any non-live status)", () => {
    assert.equal(isTerminalQuestionPart(part({})), "call_9");
    assert.equal(
      isTerminalQuestionPart(part({ state: { status: "completed" } })),
      "call_9",
    );
  });

  it("rejects live, arriving and malformed parts", () => {
    for (const bad of [
      part({ state: { status: "running" } }),
      part({ state: { status: "streaming" } }),
      part({ state: {} }),
      part({ name: "shell" }),
      part({ type: "text" }),
      part({ id: undefined }),
      null,
      undefined,
    ]) {
      assert.equal(isTerminalQuestionPart(bad), undefined, JSON.stringify(bad));
    }
  });
});
