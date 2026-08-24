import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterSlashEntries, type SlashEntry } from "../webview-src/lib/slash";

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
  it("filters by kind", () => {
    assert.deepEqual(filterSlashEntries(entries, "", "command").map((e) => e.name), ["review", "init"]);
    assert.deepEqual(filterSlashEntries(entries, "", "skill").map((e) => e.name), ["deep-research", "testgen"]);
    assert.equal(filterSlashEntries(entries, "", "all").length, 4);
    // query + kind compose
    assert.deepEqual(filterSlashEntries(entries, "re", "skill").map((e) => e.name), ["deep-research"]);
    assert.equal(filterSlashEntries(entries, "re", "command").length, 1); // review
    assert.equal(filterSlashEntries(entries, "zzz", "skill").length, 0);
  });
  it("routes local (gui) entries to their own filter", () => {
    const withGui: SlashEntry[] = [
      ...entries,
      { kind: "command", name: "undo", description: "revert", local: true },
    ];
    // plain Commands excludes gui entries…
    assert.equal(filterSlashEntries(withGui, "", "command").some((e) => e.local), false);
    // …the GUI filter shows only them…
    const gui = filterSlashEntries(withGui, "", "gui");
    assert.equal(gui.length, 1);
    assert.equal(gui[0]!.name, "undo");
    // …and All still shows everything.
    assert.equal(filterSlashEntries(withGui, "", "all").length, 5);
  });
  it("caps results at 40", () => {
    const many: SlashEntry[] = Array.from({ length: 60 }, (_, i) => ({ kind: "command", name: `cmd${i}` }));
    assert.equal(filterSlashEntries(many, "").length, 40);
    assert.equal(filterSlashEntries(many, "", "skill").length, 0);
  });
});
