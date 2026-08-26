import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROVIDERISH_RE, assistantFailed } from "../webview-src/lib/failure";

describe("PROVIDERISH_RE", () => {
  it("matches upstream provider rejects incl. Console Go invalid params", () => {
    const samples = [
      "Error from provider (Console Go): Upstream request failed: [invalid_request_error] The request contains invalid parameters",
      "No endpoints available matching your guardrail restrictions and data policy",
      "provider.invalid-request: 404",
      "OpenAI Chat stream ended without finish_reason",
      "rate limited by the model provider",
    ];
    for (const s of samples) assert.ok(PROVIDERISH_RE.test(s), s);
  });
  it("does not match ordinary failures", () => {
    assert.equal(PROVIDERISH_RE.test("Permission denied"), false);
    assert.equal(PROVIDERISH_RE.test("timeout waiting for permission"), false);
    assert.equal(PROVIDERISH_RE.test("No such file"), false);
  });
});

describe("assistantFailed", () => {
  it("still detects failed assistant messages", () => {
    const m = { type: "assistant", id: "x", finish: "error", error: { message: "boom" } };
    assert.equal(assistantFailed(m as never), true);
    const ok = { type: "assistant", id: "y", finish: "stop" };
    assert.equal(assistantFailed(ok as never), false);
  });
});