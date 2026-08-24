import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isInbound,
  isRpcRequest,
  isSettingKey,
  validateSettingValue,
} from "../src/protocol";

describe("isInbound", () => {
  it("accepts known inbound shapes", () => {
    assert.equal(isInbound({ type: "ready", density: "compact" }), true);
    assert.equal(isInbound({ type: "connection", state: "connected" }), true);
    assert.equal(isInbound({ type: "resync" }), true);
    assert.equal(isInbound({ type: "event", event: {} }), true);
    assert.equal(isInbound({ type: "selectSession", id: "ses_x" }), true);
  });
  it("rejects non-messages", () => {
    assert.equal(isInbound(null), false);
    assert.equal(isInbound(42), false);
    assert.equal(isInbound({ nope: true }), false);
    assert.equal(isInbound({ type: 7 }), false);
  });
});

describe("isRpcRequest", () => {
  it("accepts rpc envelopes", () => {
    const req = { type: "rpc", id: 1, method: "session.list" };
    assert.equal(isRpcRequest(req), true);
    if (isRpcRequest(req)) {
      assert.equal(req.id, 1);
      assert.equal(req.method, "session.list");
    }
  });
  it("rejects non-rpc and malformed envelopes", () => {
    assert.equal(isRpcRequest({ type: "hello" }), false);
    assert.equal(isRpcRequest({ id: 1, method: "x" }), false);
    assert.equal(isRpcRequest(undefined), false);
  });
});

describe("settings guards", () => {
  it("recognises known keys incl. ui.theme", () => {
    assert.equal(isSettingKey("ui.theme"), true);
    assert.equal(isSettingKey("ui.density"), true);
    assert.equal(isSettingKey("ui.nope"), false);
  });
  it("validates ui.theme values", () => {
    assert.deepEqual(validateSettingValue("ui.theme", "dark"), { ok: true });
    assert.deepEqual(validateSettingValue("ui.theme", "light"), { ok: true });
    assert.deepEqual(validateSettingValue("ui.theme", "tokyonight"), {
      ok: true,
    });
    assert.deepEqual(validateSettingValue("ui.theme", "catppuccin"), {
      ok: true,
    });
    assert.equal(validateSettingValue("ui.theme", "system").ok, false);
    assert.equal(validateSettingValue("ui.theme", 1).ok, false);
  });
});
