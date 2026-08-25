import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextPercent,
  diffLines,
  formatCost,
  formatTokens,
  liveContextStepTokens,
  totalTokens,
  toolTitle,
  truncate,
} from "../webview-src/lib/format";
import type { UsageMessage } from "../webview-src/lib/format";

describe("formatCost", () => {
  it("formats small values with precision", () => {
    assert.equal(formatCost(0.0012), "$0.0012");
    assert.equal(formatCost(0.5), "$0.500");
    assert.equal(formatCost(12.345), "$12.35");
  });
  it("handles zero and unknown", () => {
    assert.equal(formatCost(0), "$0");
    assert.equal(formatCost(undefined), "—");
    assert.equal(formatCost(Number.NaN), "—");
  });
});

describe("formatTokens", () => {
  it("scales to k and M", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(4200), "4.2k");
    assert.equal(formatTokens(1_500_000), "1.5M");
  });
});

describe("totalTokens", () => {
  it("sums all five components", () => {
    const t = {
      input: 100,
      output: 50,
      reasoning: 25,
      cache: { read: 30, write: 5 },
    };
    assert.equal(totalTokens(t), 210);
  });
  it("returns undefined for missing/invalid usage", () => {
    assert.equal(totalTokens(undefined), undefined);
    const bad = {
      input: Number.NaN,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    assert.equal(totalTokens(bad), undefined);
  });
});

describe("contextPercent", () => {
  const tokens = {
    input: 100,
    output: 50,
    reasoning: 50,
    cache: { read: 100, write: 0 },
  };
  it("computes percent of limit", () => {
    assert.equal(contextPercent(tokens, 1000), 30);
  });
  it("clamps at 100", () => {
    const big = {
      input: 900,
      output: 900,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    assert.equal(contextPercent(big, 1000), 100);
  });
  it("returns null without a limit", () => {
    assert.equal(contextPercent(tokens, undefined), null);
    assert.equal(contextPercent(undefined, 1000), null);
    assert.equal(contextPercent(tokens, 0), null);
  });
});

describe("diffLines", () => {
  it("classifies added/removed/meta/context", () => {
    const lines = diffLines(
      ["diff --git a/x b/x", "@@ -1 +1 @@", "-old", "+new", "same"].join("\n"),
    );
    assert.deepEqual(
      lines.map((l) => l.cls),
      ["meta", "meta", "del", "add", "ctx"],
    );
  });
});

describe("toolTitle", () => {
  it("prefers file path basenames", () => {
    assert.equal(
      toolTitle("read", { filePath: "src/deep/name.ts" }),
      "read: name.ts",
    );
  });
  it("falls back to the tool name", () => {
    assert.equal(toolTitle("grep", {}), "grep");
  });
  it("truncates long targets", () => {
    const t = toolTitle("bash", { command: "x".repeat(80) });
    assert.ok(t.length <= "bash: ".length + 48);
    assert.ok(t.endsWith("…"));
  });
});

describe("truncate", () => {
  it("keeps short strings intact", () => {
    assert.equal(truncate("hello", 10), "hello");
  });
  it("cuts with ellipsis", () => {
    assert.equal(truncate("hello world", 8), "hello w…");
  });
});

describe("liveContextStepTokens", () => {
  const usage = (input: number) => ({
    input,
    output: 10,
    reasoning: 0,
    cache: { read: input * 10, write: 0 },
  });
  const step = (created: number, input: number): UsageMessage => ({
    type: "assistant",
    time: { created },
    tokens: input > 0 ? usage(input) : { ...usage(0), input: 0 },
  });

  it("returns undefined for empty or missing lists", () => {
    assert.equal(liveContextStepTokens(undefined), undefined);
    assert.equal(liveContextStepTokens([]), undefined);
  });

  it("picks the newest assistant step when there is no checkpoint", () => {
    const msgs = [step(100, 5), step(300, 9), step(200, 7)];
    // unordered on purpose — max timestamp must win
    assert.equal(liveContextStepTokens(msgs)?.input, 9);
  });

  it("ignores steps at/before the newest synthetic checkpoint", () => {
    const msgs = [
      step(100, 5),
      { type: "synthetic", time: { created: 150 } },
      step(200, 7),
    ];
    assert.equal(liveContextStepTokens(msgs)?.input, 7);
  });

  it("returns undefined when every step is pre-checkpoint", () => {
    const msgs = [
      step(100, 5),
      { type: "synthetic", time: { created: 200 } },
      step(150, 7),
    ];
    assert.equal(liveContextStepTokens(msgs), undefined);
  });

  it("uses the newest checkpoint when several exist", () => {
    const msgs = [
      { type: "synthetic", time: { created: 120 } },
      step(200, 7),
      { type: "synthetic", time: { created: 250 } },
      step(300, 9),
    ];
    assert.equal(liveContextStepTokens(msgs)?.input, 9);
  });

  it("ignores assistant rows without positive input usage", () => {
    const msgs = [step(100, 0), step(50, 4)];
    assert.equal(liveContextStepTokens(msgs)?.input, 4);
  });

  it("ignores non-assistant rows entirely", () => {
    const msgs: UsageMessage[] = [
      { type: "user", time: { created: 400 } },
      step(100, 5),
    ];
    assert.equal(liveContextStepTokens(msgs)?.input, 5);
  });
});
