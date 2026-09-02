import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuestionInput } from "../webview-src/lib/questions";

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
