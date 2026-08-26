import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
/**
 * Drift guard: every key in the webview event-routing table must be a real
 * literal in the installed SDK's V2Event union. Catches the class of bug
 * where a routed event name drifts from the SDK (e.g. the dead
 * "session.usage.recorded" route that never fired).
 */
describe("event routing drift guard", () => {
  const typesPath =
    "node_modules/@opencode-ai/client/dist/promise/generated/types.d.ts";

  it("routes only literals that exist in the SDK V2Event union", () => {
    const t = readFileSync(typesPath, "utf8");
    const um = /export type V2Event =\s*([\s\S]*?);/.exec(t);
    assert.ok(um, "V2Event union not found in SDK types");
    const members = [...um[1].matchAll(/(\w+)/g)].map((m) => m[1]);
    const literals = new Set<string>();
    for (const mem of members) {
      const def = new RegExp(`export type ${mem} = [\\s\\S]{0,1200}`).exec(t);
      if (!def) continue;
      const lm = /type:\s*"([^"]+)"/.exec(def[0]);
      if (lm) literals.add(lm[1]);
    }
    assert.ok(literals.size > 50, "union extraction sanity check");

    // Extract TABLE keys by importing the module and reflecting is impossible
    // (table not exported) — instead parse events.ts source for quoted keys.
    const src = readFileSync("webview-src/lib/events.ts", "utf8");
    const tableKeys = [
      ...src.matchAll(/^\s{2}"([a-z]+(?:\.[a-z]+)+)":/gm),
    ].map((m) => m[1]);
    assert.ok(tableKeys.length > 40, `expected many routes, got ${tableKeys.length}`);

    const unknown = tableKeys.filter((k) => !literals.has(k));
    assert.deepEqual(
      unknown,
      [],
      `routing table contains events missing from the SDK union: ${unknown.join(", ")}`,
    );
  });

  it("every non-ignored SDK event is either routed or explicitly documented as ignored", () => {
    const t = readFileSync(typesPath, "utf8");
    const src = readFileSync("webview-src/lib/events.ts", "utf8");
    const um = /export type V2Event =\s*([\s\S]*?);/.exec(t);
    assert.ok(um);
    const members = [...um[1].matchAll(/(\w+)/g)].map((m) => m[1]);
    const literals = new Set<string>();
    for (const mem of members) {
      const def = new RegExp(`export type ${mem} = [\\s\\S]{0,1200}`).exec(t);
      if (!def) continue;
      const lm = /type:\s*"([^"]+)"/.exec(def[0]);
      if (lm) literals.add(lm[1]);
    }
    // Deliberately-ignored families (documented in events.ts header + MEMORY).
    const ignoredPrefixes = ["tui.", "installation.", "pty.", "shell."];
    const ignoredExact = new Set([
      "config.updated",
      "plugin.added",
      "plugin.updated",
      "models-dev.refreshed",
      "catalog.updated",
      "agent.updated",
      "filesystem.changed",
      "server.connected",
      "session.viewed",
      "reference.updated",
      "websearch.updated",
    ]);
    const tableKeys = new Set(
      [...src.matchAll(/^\s{2}"([a-z]+(?:\.[a-z]+)+)":/gm)].map((m) => m[1]),
    );
    const unrouted = [...literals].filter(
      (l) =>
        !tableKeys.has(l) &&
        !ignoredExact.has(l) &&
        !ignoredPrefixes.some((p) => l.startsWith(p)),
    );
    assert.deepEqual(
      unrouted,
      [],
      `SDK events with no route and not documented as ignored: ${unrouted.join(", ")}`,
    );
  });
});
