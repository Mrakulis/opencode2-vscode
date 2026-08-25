import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assistantFailed, type AnyMessage } from "../webview-src/lib/failure";

const assistant = (extra: Record<string, unknown> = {}): AnyMessage => ({
  type: "assistant",
  id: "msg_1",
  agent: "build",
  time: { created: 1 },
  content: [],
  ...extra,
});

describe("assistantFailed", () => {
  it("is false for healthy messages", () => {
    assert.equal(assistantFailed(assistant({ finish: "stop" })), false);
    assert.equal(assistantFailed(assistant({ finish: "tool-calls" })), false);
    assert.equal(assistantFailed(assistant()), false);
  });

  it("detects finish === 'error'", () => {
    assert.equal(assistantFailed(assistant({ finish: "error" })), true);
  });

  it("detects an error object even without finish", () => {
    assert.equal(
      assistantFailed(
        assistant({ error: { type: "provider.internal", message: "boom" } }),
      ),
      true,
    );
  });

  it("detects a persisted server-retry marker", () => {
    assert.equal(
      assistantFailed(
        assistant({ retry: { attempt: 2, at: 123, error: { message: "x" } } }),
      ),
      true,
    );
  });

  it("rejects non-assistant messages", () => {
    const user: AnyMessage = {
      type: "user",
      id: "u1",
      text: "hi",
      time: { created: 1 },
    };
    assert.equal(assistantFailed(user), false);
    const synthetic: AnyMessage = { type: "synthetic", id: "s1" };
    assert.equal(assistantFailed(synthetic), false);
  });
});