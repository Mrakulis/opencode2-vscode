import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isParkedQuestionPart,
  isParkedQuestionWithData,
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

describe("isParkedQuestionWithData", () => {
  const part = (over: Record<string, unknown>) => ({
    type: "tool",
    name: "question",
    id: "call_2",
    state: { status: "running", input: { questions: [{ question: "hi" }] } },
    ...over,
  });

  it("matches a parked question only when its input parses to a question list", () => {
    assert.equal(isParkedQuestionWithData(part({})), "call_2");
    assert.equal(
      isParkedQuestionWithData(
        part({ state: { status: "streaming", input: { questions: [{ question: "hi" }] } } }),
      ),
      "call_2",
    );
    // Raw JSON string emitted while streaming still counts once complete.
    assert.equal(
      isParkedQuestionWithData(
        part({ state: { status: "streaming", input: JSON.stringify({ questions: [{ question: "hi" }] }) } }),
      ),
      "call_2",
    );
  });

  it("does not match while input is empty, unparseable or absent", () => {
    for (const bad of [
      part({ state: { status: "running", input: {} } }),
      part({ state: { status: "running", input: undefined } }),
      part({ state: { status: "running", input: { questions: [] } } }),
      part({ state: { status: "streaming", input: "{ incomplete" } }),
      part({ state: { status: "streaming", input: "not json" } }),
      part({ state: { status: "streaming" } }),
    ]) {
      assert.equal(
        isParkedQuestionWithData(bad),
        undefined,
        JSON.stringify(bad),
      );
    }
  });

  it("rejects terminal states, other tools and malformed parts", () => {
    for (const bad of [
      part({ state: { status: "completed", input: { questions: [{ question: "hi" }] } } }),
      part({ state: { status: "error", input: { questions: [{ question: "hi" }] } } }),
      part({ name: "shell" }),
      part({ type: "text" }),
      part({ id: undefined }),
      null,
      undefined,
      "question",
    ]) {
      assert.equal(
        isParkedQuestionWithData(bad),
        undefined,
        JSON.stringify(bad),
      );
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
