import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autoReplyFor,
  RespondedTracker,
  PERMISSION_RESPONDED_TTL_MS,
  sameSessionPending,
  lostReplyIds,
} from "../webview-src/lib/permissions";

describe("autoReplyFor", () => {
  it("never auto-responds to questions", () => {
    assert.equal(autoReplyFor("autoAllow", "question"), undefined);
    assert.equal(autoReplyFor("deny", "Question"), undefined);
    assert.equal(autoReplyFor("askFirst", "question", true), undefined);
  });
  it("autoAllow replies once", () => {
    assert.equal(autoReplyFor("autoAllow", "shell"), "once");
    assert.equal(autoReplyFor("autoAllow", "edit", true), "once");
  });
  it("deny replies reject", () => {
    assert.equal(autoReplyFor("deny", "shell"), "reject");
  });
  it("askFirst asks unless the session is auto-accepting", () => {
    assert.equal(autoReplyFor("askFirst", "shell"), undefined);
    assert.equal(autoReplyFor("askFirst", "edit", true), "once");
  });
  it("autoAllow still asks for external_directory unless session auto-accepting", () => {
    assert.equal(autoReplyFor("autoAllow", "external_directory"), undefined);
    assert.equal(autoReplyFor("autoAllow", "external_directory", true), "once");
    assert.equal(autoReplyFor("autoAllow", "edit"), "once");
  });
});

describe("RespondedTracker", () => {
  it("marks, checks and clears", () => {
    const t = new RespondedTracker();
    assert.equal(t.had("rid1"), false);
    t.mark("rid1");
    assert.equal(t.had("rid1"), true);
    t.clear("rid1");
    assert.equal(t.had("rid1"), false);
  });
  it("re-marks a seen id (MRU) and returns keys in insertion order", () => {
    const t = new RespondedTracker();
    t.mark("a");
    t.mark("b");
    assert.equal(t.had("a"), true);
    t.mark("a");
    assert.deepEqual(t.order(), ["b", "a"]);
  });
  it("prunes entries past the TTL via the injected clock", () => {
    const t = new RespondedTracker();
    t.mark("a", 0);
    t.mark("b", 1000);
    const past = PERMISSION_RESPONDED_TTL_MS + 2000;
    assert.equal(t.had("a", past), false);
    assert.equal(t.had("b", past), false);
    // a freshly marked entry at `past` is still present
    t.mark("c", past);
    assert.equal(t.had("c", past), true);
  });
  it("keeps entries within the TTL", () => {
    const t = new RespondedTracker();
    t.mark("a", 0);
    assert.equal(t.had("a", PERMISSION_RESPONDED_TTL_MS - 1), true);
  });
  it("caps the map at PERMISSION_RESPONDED_MAX", () => {
    const t = new RespondedTracker();
    for (let i = 0; i < 1100; i++) t.mark(`id-${i}`);
    assert.ok(t.order().length <= 1000);
  });
});

describe("sameSessionPending", () => {
  const list = [
    { sessionID: "s1", requestID: "r1" },
    { sessionID: "s1", requestID: "r2" },
    { sessionID: "s2", requestID: "r3" },
  ];
  it("returns only same-session IDs, excluding the rejected one", () => {
    assert.deepEqual(sameSessionPending(list, "s1", "r1"), ["r2"]);
  });
  it("returns [] when no other requests share the session", () => {
    assert.deepEqual(sameSessionPending(list, "s2", "r3"), []);
  });
  it("excludes other sessions entirely", () => {
    assert.deepEqual(sameSessionPending(list, "s1", "x"), ["r1", "r2"]);
  });
});

describe("lostReplyIds", () => {
  it("returns still-pending ids whose reply mark was lost on resync", () => {
    const t = new RespondedTracker();
    t.mark("r1");
    t.mark("r2");
    // Server still lists r1 (reply lost); r2 dropped (answered); r3 is new.
    assert.deepEqual(lostReplyIds(t, ["r1", "r3"]), ["r1"]);
  });
  it("returns [] when no marked id is still pending", () => {
    const t = new RespondedTracker();
    t.mark("r1");
    assert.deepEqual(lostReplyIds(t, ["r2", "r3"]), []);
  });
  it("returns [] when nothing was marked", () => {
    const t = new RespondedTracker();
    assert.deepEqual(lostReplyIds(t, ["r1"]), []);
  });
});