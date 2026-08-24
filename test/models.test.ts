import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterVisibleModels,
  groupByProvider,
  modelKey,
  parseModelKey,
  resolveDefault,
  toggleInList,
  toggleProviderModels,
} from "../webview-src/lib/models";

const m = (providerID: string, id: string, name?: string) => ({
  providerID,
  id,
  name,
});

describe("modelKey / parseModelKey", () => {
  it("round-trips", () => {
    const key = modelKey({ providerID: "anthropic", id: "claude-x" });
    assert.equal(key, "anthropic/claude-x");
    assert.deepEqual(parseModelKey(key), {
      providerID: "anthropic",
      id: "claude-x",
    });
  });
  it("rejects malformed keys", () => {
    assert.equal(parseModelKey("noseparator"), undefined);
    assert.equal(parseModelKey("/leading"), undefined);
    assert.equal(parseModelKey("trailing/"), undefined);
  });
});

describe("filterVisibleModels", () => {
  const models = [m("a", "1"), m("b", "2"), m("b", "3")];
  it("drops hidden models", () => {
    const visible = filterVisibleModels(models, ["b/2"]);
    assert.deepEqual(
      visible.map((x) => modelKey(x)),
      ["a/1", "b/3"],
    );
  });
  it("keeps everything when hidden is empty", () => {
    assert.equal(filterVisibleModels(models, []).length, 3);
  });
});

describe("groupByProvider", () => {
  it("groups and sorts by providerID", () => {
    const groups = groupByProvider([
      m("zeta", "1"),
      m("alpha", "2"),
      m("alpha", "3"),
    ]);
    assert.deepEqual(
      groups.map((g) => g.providerID),
      ["alpha", "zeta"],
    );
    assert.equal(groups[0]?.models.length, 2);
  });
});

describe("toggleProviderModels", () => {
  const models = [m("a", "1"), m("a", "2"), m("b", "3")];
  it("hides all provider models when any visible", () => {
    const next = toggleProviderModels([], "a", models);
    assert.deepEqual(next.sort(), ["a/1", "a/2"]);
  });
  it("reveals all when none visible", () => {
    const next = toggleProviderModels(["a/1", "a/2"], "a", models);
    assert.deepEqual(next, []);
  });
  it("leaves other providers untouched", () => {
    const next = toggleProviderModels(["b/3"], "a", models);
    assert.deepEqual(next.sort(), ["a/1", "a/2", "b/3"]);
  });
});

describe("toggleInList", () => {
  it("adds and removes", () => {
    assert.deepEqual(toggleInList(["x"], "y"), ["x", "y"]);
    assert.deepEqual(toggleInList(["x", "y"], "y"), ["x"]);
  });
});

describe("resolveDefault", () => {
  it("prefers the setting key", () => {
    assert.deepEqual(
      resolveDefault("openai/gpt-5", { id: "claude", providerID: "anthropic" }),
      { id: "gpt-5", providerID: "openai" },
    );
  });
  it("falls back to server default", () => {
    assert.deepEqual(
      resolveDefault("", { id: "claude", providerID: "anthropic" }),
      {
        id: "claude",
        providerID: "anthropic",
      },
    );
    assert.equal(resolveDefault("", null), undefined);
    assert.equal(resolveDefault("", undefined), undefined);
  });
});
