import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectedAuthHeader, formatListenUrl, isLoopback, isSseRequest, isSseResponse, parseHostHeader, SSE_HEARTBEAT_MS, SSE_PING } from "../src/listenConfig";

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

describe("formatListenUrl", () => {
  it("brackets IPv6 literals so the advertised URL is parsable", () => {
    assert.equal(formatListenUrl("::1", 12421), "http://[::1]:12421");
    assert.equal(formatListenUrl("fe80::1", 12421), "http://[fe80::1]:12421");
    assert.equal(formatListenUrl("::ffff:127.0.0.1", 12421), "http://[::ffff:127.0.0.1]:12421");
  });
  it("passes IPv4, names, and pre-bracketed hosts through verbatim", () => {
    assert.equal(formatListenUrl("127.0.0.1", 12421), "http://127.0.0.1:12421");
    assert.equal(formatListenUrl("0.0.0.0", 12421), "http://0.0.0.0:12421");
    assert.equal(formatListenUrl("myhost.tailnet", 12421), "http://myhost.tailnet:12421");
    assert.equal(formatListenUrl("[::1]", 12421), "http://[::1]:12421");
  });
});

describe("SSE keep-alive", () => {
  it("detects SSE subscriptions by path", () => {
    assert.equal(isSseRequest("GET", "/api/event", undefined), true);
    assert.equal(isSseRequest("GET", "/api/event?x=1", undefined), true);
    assert.equal(isSseRequest("GET", "/event", undefined), true);
  });
  it("detects SSE subscriptions by Accept header", () => {
    assert.equal(isSseRequest("GET", "/api/foo", "text/event-stream"), true);
    assert.equal(isSseRequest("GET", "/api/foo", ["text/html", "text/event-stream"]), true);
  });
  it("rejects non-SSE traffic", () => {
    assert.equal(isSseRequest("POST", "/api/event", undefined), false);
    assert.equal(isSseRequest("GET", "/api/session", "application/json"), false);
    assert.equal(isSseRequest("GET", undefined, undefined), false);
    assert.equal(isSseRequest(undefined, "/api/event", undefined), false);
  });
  it("detects SSE responses by content-type", () => {
    assert.equal(isSseResponse("text/event-stream"), true);
    assert.equal(isSseResponse("text/event-stream; charset=utf-8"), true);
    assert.equal(isSseResponse(["text/html", "text/event-stream"]), true);
    assert.equal(isSseResponse("application/json"), false);
    assert.equal(isSseResponse(undefined), false);
  });
  it("heartbeat is a spec no-op comment on a sub-NAT interval", () => {
    assert.equal(SSE_PING, ": ping\n\n");
    assert.ok(SSE_PING.startsWith(":"));
    assert.ok(SSE_HEARTBEAT_MS < 30_000);
  });
});
