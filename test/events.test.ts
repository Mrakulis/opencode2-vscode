import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  actionsForEvent,
  isSessionScopedAction,
} from "../webview-src/lib/events";
import { applyDelta, type DeltaEvent } from "../webview-src/lib/deltas";
import type { AnyMessage } from "../webview-src/lib/rpc";

describe("actionsForEvent", () => {
  it("routes every valuable V2 event family", () => {
    assert.ok(
      actionsForEvent("session.execution.succeeded").includes("sessions"),
    );
    assert.ok(actionsForEvent("form.created").includes("forms"));
    assert.ok(actionsForEvent("mcp.status.changed").includes("mcp"));
    assert.ok(actionsForEvent("integration.updated").includes("providers"));
    assert.ok(actionsForEvent("config.updated").length === 0);
    assert.ok(actionsForEvent("vcs.branch.updated").includes("vcs"));
    assert.ok(actionsForEvent("worktree.resolved").includes("worktrees"));
    assert.ok(actionsForEvent("command.updated").includes("commands"));
    assert.ok(actionsForEvent("session.revert.committed").includes("messages"));
    assert.ok(actionsForEvent("permission.asked").includes("permissions"));
  });
  it("ignores TUI/CLI-only events explicitly", () => {
    assert.deepEqual(actionsForEvent("tui.prompt.append"), []);
    assert.deepEqual(actionsForEvent("installation.update.available"), []);
    assert.deepEqual(actionsForEvent("unknown.event"), []);
  });
  it("does not refetch on delta events (accumulator owns those)", () => {
    assert.deepEqual(actionsForEvent("session.text.delta"), []);
    assert.deepEqual(actionsForEvent("session.reasoning.delta"), []);
  });
  it("marks only message refreshes as session-scoped", () => {
    assert.equal(isSessionScopedAction("messages"), true);
    assert.equal(isSessionScopedAction("sessions"), false);
  });
});

describe("applyDelta", () => {
  const base: AnyMessage[] = [
    { type: "user", id: "u1", text: "hi", time: { created: 1 } },
    {
      type: "assistant",
      id: "m1",
      agent: "build",
      time: { created: 2 },
      content: [{ type: "text", text: "Hel" }],
    } as unknown as AnyMessage,
  ];

  const evt = (
    over: Partial<DeltaEvent["data"]> & { text?: string },
    type = "session.text.delta",
  ): DeltaEvent => ({
    type,
    data: { messageID: "m1", ...over },
  });

  it("appends to an existing text part", () => {
    const out = applyDelta(base, evt({ text: "lo" }));
    assert.ok(out);
    const m = out![1] as Extract<AnyMessage, { type: "assistant" }>;
    assert.equal((m.content[0] as { text: string }).text, "Hello");
    // original untouched (immutability)
    assert.equal(
      (base[1] as Extract<AnyMessage, { type: "assistant" }>).content.length,
      1,
    );
  });
  it("creates a reasoning block when missing", () => {
    const out = applyDelta(
      base,
      evt({ text: "hmm" }, "session.reasoning.delta"),
    );
    assert.ok(out);
    const m = out![1] as Extract<AnyMessage, { type: "assistant" }>;
    assert.equal(m.content.length, 2);
    assert.equal(m.content[1]!.type, "reasoning");
  });
  it("returns null for unknown messages / malformed payloads", () => {
    assert.equal(applyDelta(base, evt({ messageID: "nope", text: "x" })), null);
    assert.equal(
      applyDelta(base, evt({ messageID: undefined, text: "x" })),
      null,
    );
    assert.equal(
      applyDelta(base, { type: "session.tool.progress", data: {} }),
      null,
    );
  });

  // V2 deltas carry assistantMessageID + ordinal (NOT messageID).
  const v2Delta = (
    over: Partial<DeltaEvent["data"]>,
    type = "session.text.delta",
  ): DeltaEvent => ({ type, data: { assistantMessageID: "m1", ...over } });

  it("merges using the V2 assistantMessageID key", () => {
    const out = applyDelta(base, v2Delta({ delta: "lo" }));
    assert.ok(out);
    const m = out![1] as Extract<AnyMessage, { type: "assistant" }>;
    assert.equal((m.content[0] as { text: string }).text, "Hello");
  });
  it("targets the part by ordinal when it matches the delta kind", () => {
    const withReasoning: AnyMessage[] = [
      base[0]!,
      {
        type: "assistant",
        id: "m1",
        agent: "build",
        time: { created: 2 },
        content: [
          { type: "text", text: "Hel" },
          { type: "reasoning", text: "hmm" },
        ],
      } as unknown as AnyMessage,
    ];
    const out = applyDelta(
      withReasoning,
      v2Delta({ delta: "m" }, "session.reasoning.delta"),
    );
    assert.ok(out);
    const m = out![1] as Extract<AnyMessage, { type: "assistant" }>;
    assert.equal((m.content[1] as { text: string }).text, "hmmm");
    // text ordinal still appends to text
    const out2 = applyDelta(
      withReasoning,
      v2Delta({ delta: "lo", ordinal: 0 }),
    );
    assert.ok(out2);
    const m2 = out2![1] as Extract<AnyMessage, { type: "assistant" }>;
    assert.equal((m2.content[0] as { text: string }).text, "Hello");
  });
  it("creates a part at the ordinal slot when it is beyond the end", () => {
    const onlyText: AnyMessage[] = [
      base[0]!,
      {
        type: "assistant",
        id: "m1",
        agent: "build",
        time: { created: 2 },
        content: [{ type: "text", text: "Hel" }],
      } as unknown as AnyMessage,
    ];
    const out = applyDelta(
      onlyText,
      v2Delta({ delta: "we", ordinal: 1 }, "session.reasoning.delta"),
    );
    assert.ok(out);
    const m = out![1] as Extract<AnyMessage, { type: "assistant" }>;
    assert.equal(m.content[1]!.type, "reasoning");
    assert.equal((m.content[1] as { text: string }).text, "we");
  });
  it("falls back to matching part when ordinal points at a different kind", () => {
    const withBoth: AnyMessage[] = [
      base[0]!,
      {
        type: "assistant",
        id: "m1",
        agent: "build",
        time: { created: 2 },
        content: [
          { type: "reasoning", text: "think" },
          { type: "text", text: "Hel" },
        ],
      } as unknown as AnyMessage,
    ];
    // text delta with ordinal 0 (which is the reasoning part) → must append to text
    const out = applyDelta(withBoth, v2Delta({ delta: "lo", ordinal: 0 }));
    assert.ok(out);
    const m = out![1] as Extract<AnyMessage, { type: "assistant" }>;
    assert.equal((m.content[1] as { text: string }).text, "Hello");
  });
});
