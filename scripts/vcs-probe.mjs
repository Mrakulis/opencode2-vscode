// Probe: verify the live /vcs/status (and /vcs/get) shapes against the beta
// server — the branch-chip badge aggregates VcsFileStatus additions/deletions.
// VERIFIED 2026-08-28: the query param `location` must be a FLAT LocationRef
// (bracket notation `location[directory]=...`). The pinned SDK's typed input
// ({location:{location:{directory}}}) is silently ignored and the call
// resolves to the home directory — the adapter casts around this drift.
// Run: node scripts/vcs-probe.mjs
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

const endpoint = await Service.discover();
if (!endpoint) {
  console.log("no service discovered");
  process.exit(1);
}
const c = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
});

// Canonical form: lowercase win32 drive + forward slashes (matches
// canonicalizeDirectory in src/directory.ts).
const dir = process
  .cwd()
  .replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ":")
  .replace(/\\/g, "/");
console.log("directory:", dir);
const loc = { location: { directory: dir } };

console.log("== client.vcs.status() (flat location) ==");
try {
  const res = await c.vcs.status(loc);
  const rows = Array.isArray(res) ? res : (res.data ?? []);
  console.log(
    JSON.stringify(
      {
        wrapped: !Array.isArray(res),
        files: rows.length,
        sample: rows.slice(0, 3),
        totals: rows.reduce(
          (acc, r) => ({
            added: acc.added + (r.additions ?? 0),
            removed: acc.removed + (r.deletions ?? 0),
          }),
          { added: 0, removed: 0 },
        ),
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.log("status error:", e?.message ?? e);
}

console.log("== client.vcs.get() (flat location) ==");
try {
  const res = await c.vcs.get(loc);
  console.log(JSON.stringify(res.data ?? res, null, 2).slice(0, 400));
} catch (e) {
  console.log("get error:", e?.message ?? e);
}
