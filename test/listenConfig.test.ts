import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectedAuthHeader, isLoopback } from "../src/listenConfig";

describe("isLoopback", () => {
  it("accepts loopback hostnames", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopback(h), true, h);
    }
  });
  it("treats non-loopback binds as remote (password required)", () => {
    for (const h of ["0.0.0.0", "192.168.1.10", "example.com", "127.0.0.2", ""]) {
      assert.equal(isLoopback(h), false, h);
    }
  });
});

describe("expectedAuthHeader", () => {
  it("builds the exact Basic header the server compares against", () => {
    assert.equal(
      expectedAuthHeader("opencode", "pw"),
      "Basic " + Buffer.from("opencode:pw").toString("base64"),
    );
  });
  it("keeps the colon separator and supports an empty password", () => {
    const header = expectedAuthHeader("u", "");
    assert.ok(header.startsWith("Basic "));
    assert.equal(Buffer.from(header.slice(6), "base64").toString("utf8"), "u:");
  });
});
