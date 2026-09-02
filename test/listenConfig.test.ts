import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectedAuthHeader, isLoopback, parseHostHeader } from "../src/listenConfig";

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

describe("parseHostHeader", () => {
  it("splits host and port (IPv4, names, bracketed IPv6)", () => {
    assert.equal(parseHostHeader("127.0.0.1:12421"), "127.0.0.1");
    assert.equal(parseHostHeader("localhost:12421"), "localhost");
    assert.equal(parseHostHeader("[::1]:12421"), "::1");
    assert.equal(parseHostHeader("  evil.example.com:80  "), "evil.example.com");
  });
  it("passes bare hosts through (incl. bracketless IPv6)", () => {
    assert.equal(parseHostHeader("localhost"), "localhost");
    assert.equal(parseHostHeader("::1"), "::1");
    assert.equal(parseHostHeader("attacker.example.com"), "attacker.example.com");
  });
  it("returns undefined for missing/empty/malformed headers", () => {
    assert.equal(parseHostHeader(undefined), undefined);
    assert.equal(parseHostHeader(""), undefined);
    assert.equal(parseHostHeader("   "), undefined);
    assert.equal(parseHostHeader("[::1"), undefined);
  });
});
