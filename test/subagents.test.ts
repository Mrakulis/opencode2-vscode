import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childrenOf, isSubagentActive } from "../webview-src/lib/subagents";

const s = (
  id: string,
  parentID?: string,
  time?: { idle?: number; archived?: number },
) => ({
  id,
  parentID,
  time: { created: 1, updated: 2, idle: time?.idle, archived: time?.archived },
});

describe("childrenOf", () => {
  it("returns only direct children of the parent, newest first", () => {
    const list = [
      s("root"),
      { ...s("c1", "root"), time: { created: 1, updated: 10 } },
      { ...s("c2", "root"), time: { created: 1, updated: 20 } },
      s("other", "ses_other"),
    ];
    const kids = childrenOf(list as never[], "root");
    assert.deepEqual(
      kids.map((k) => k.id),
      ["c2", "c1"],
    );
  });
  it("returns nothing without a parent", () => {
    assert.equal(childrenOf([s("a")] as never[], undefined).length, 0);
  });
});

describe("isSubagentActive", () => {
  it("is active until an idle timestamp lands", () => {
    assert.equal(isSubagentActive(s("x") as never), true);
    assert.equal(isSubagentActive(s("y", undefined, { idle: 5 }) as never), false);
  });
  it("never active after archive", () => {
    assert.equal(
      isSubagentActive(s("z", undefined, { archived: 9 }) as never),
      false,
    );
  });
});
