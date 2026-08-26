import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterVisibleModels,
  groupByProvider,
  isFreeCatalogModel,
  modelKey,
  parseModelKey,
  pickNewSessionModel,
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
  it("puts opencode (zen) first, then opencode-go, then alphabetical", () => {
    const groups = groupByProvider([
      m("openrouter", "1"),
      m("opencode-go", "2"),
      m("google", "3"),
      m("opencode", "4"),
      m("alibaba-token-plan", "5"),
    ]);
    assert.deepEqual(
      groups.map((g) => g.providerID),
      ["opencode", "opencode-go", "alibaba-token-plan", "google", "openrouter"],
    );
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
  it("prefers last-used over everything", () => {
    assert.deepEqual(
      resolveDefault(
        { id: "ox-alpha-free", providerID: "opencode-go" },
        "openai/gpt-5",
        { id: "claude", providerID: "anthropic" },
      ),
      { id: "ox-alpha-free", providerID: "opencode-go" },
    );
  });
  it("falls back to the setting key when no last-used model", () => {
    assert.deepEqual(
      resolveDefault(undefined, "openai/gpt-5", {
        id: "claude",
        providerID: "anthropic",
      }),
      { id: "gpt-5", providerID: "openai" },
    );
  });
  it("falls back to server default", () => {
    assert.deepEqual(
      resolveDefault(undefined, "", { id: "claude", providerID: "anthropic" }),
      {
        id: "claude",
        providerID: "anthropic",
      },
    );
    assert.equal(resolveDefault(undefined, "", null), undefined);
    assert.equal(resolveDefault(undefined, "", undefined), undefined);
  });
});

describe("pickNewSessionModel", () => {
  const zen = (id: string, cost: unknown = { input: 0, output: 0 }) => ({
    providerID: "opencode",
    id,
    enabled: true,
    cost,
  });
  const catalog = [
    zen("big-pickle"),
    zen("kimi-k2.5-free"),
    {
      providerID: "openrouter",
      id: "deepseek-x",
      enabled: true,
      cost: { input: 1, output: 2 },
    },
  ];

  it("prefers last-used when it is in the catalog", () => {
    assert.deepEqual(
      pickNewSessionModel(
        { providerID: "openrouter", id: "deepseek-x" },
        "",
        null,
        catalog,
      ),
      { providerID: "openrouter", id: "deepseek-x" },
    );
  });
  it("skips a vanished last-used model and uses the setting", () => {
    assert.deepEqual(
      pickNewSessionModel(
        { providerID: "gone", id: "poof" },
        "opencode/kimi-k2.5-free",
        null,
        catalog,
      ),
      { providerID: "opencode", id: "kimi-k2.5-free" },
    );
  });
  it("falls back to big-pickle (free Zen) before the server default", () => {
    assert.deepEqual(
      pickNewSessionModel(undefined, "", { providerID: "anthropic", id: "claude" }, catalog),
      { providerID: "opencode", id: "big-pickle" },
    );
  });
  it("falls back to any free Zen model when big-pickle left the catalog", () => {
    const withoutPickle = catalog.filter((c) => c.id !== "big-pickle");
    assert.deepEqual(
      pickNewSessionModel(undefined, "", { providerID: "anthropic", id: "claude" }, withoutPickle),
      { providerID: "opencode", id: "kimi-k2.5-free" },
    );
  });
  it("uses the server default when no free Zen model exists", () => {
    const paidOnly = [catalog[2]];
    assert.deepEqual(
      pickNewSessionModel(undefined, "", { providerID: "anthropic", id: "claude" }, paidOnly),
      { providerID: "anthropic", id: "claude" },
    );
  });
  it("does not block on an empty catalog (list fetch failed)", () => {
    // No catalog → validation is skipped: setting still applies…
    assert.deepEqual(
      pickNewSessionModel(undefined, "opencode/big-pickle", null, []),
      { providerID: "opencode", id: "big-pickle" },
    );
    // …and last-used is returned unverifiable rather than blocking creation.
    assert.deepEqual(
      pickNewSessionModel({ providerID: "gone", id: "poof" }, "opencode/big-pickle", null, []),
      { providerID: "gone", id: "poof" },
    );
  });
  it("detects free models across cost shapes (array rows)", () => {
    assert.equal(
      isFreeCatalogModel({
        providerID: "opencode",
        id: "x",
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      }),
      true,
    );
    assert.equal(
      isFreeCatalogModel({
        providerID: "opencode",
        id: "x",
        cost: { input: 0.3, output: 1.2 },
      }),
      false,
    );
    assert.equal(
      isFreeCatalogModel({ providerID: "opencode", id: "x", cost: undefined }),
      false,
    );
  });
});
