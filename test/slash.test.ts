import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterSlashEntries } from "../webview-src/lib/slash";
import type { SlashEntry } from "../webview-src/lib/slash";

const entries: SlashEntry[] = [
  { kind: "command", name: "review", description: "Review changes" },
  { kind: "command", name: "init", description: "AGENTS.md setup" },
  { kind: "skill", name: "deep-research", description: "Research a topic" },
  { kind: "skill", name: "testgen" },
];

describe("filterSlashEntries", () => {
  it("returns everything (capped) for an empty query", () => {
    assert.equal(filterSlashEntries(entries, "").length, 4);
    assert.equal(filterSlashEntries(entries, "   ").length, 4);
  });
  it("matches case-insensitively on name", () => {
    const got = filterSlashEntries(entries, "RE");
    assert.deepEqual(got.map((e) => e.name).sort(), ["deep-research", "review"]);
    assert.deepEqual(filterSlashEntries(entries, "init").map((e) => e.name), ["init"]);
  });
  it("keeps commands and skills mixed", () => {
    const got = filterSlashEntries(entries, "e");
    assert.ok(got.some((e) => e.kind === "skill"));
    assert.ok(got.some((e) => e.kind === "command"));
  });
  it("caps results at 40", () => {
    const many: SlashEntry[] = Array.from({ length: 60 }, (_, i) => ({ kind: "command", name: `cmd${i}` }));
    assert.equal(filterSlashEntries(many, "").length, 40);
  });
});
