/* Live smoke test against the real V2 service. Run: node scripts/smoke.mjs
 *
 * Target resolution:
 *   1. OPENCODE_BASE_URL env (used by CI's integration job against a freshly
 *      booted beta server)
 *   2. Service.discover() — the local registered background service
 */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

let client;
if (process.env.OPENCODE_BASE_URL) {
  client = OpenCode.make({ baseUrl: process.env.OPENCODE_BASE_URL });
  console.log(`target: ${process.env.OPENCODE_BASE_URL} (from env)`);
} else {
  const endpoint = await Service.discover();
  if (!endpoint) {
    console.log(
      "SMOKE: no running service discovered and OPENCODE_BASE_URL not set.",
    );
    process.exit(0);
  }
  console.log(`target: ${endpoint.url} (discovered)`);
  client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
}

const health = await client.health.get();
console.log(`health: v${health.version} pid ${health.pid} — OK`);

const models = await client.model.list();
console.log(
  `models: ${models.data.filter((m) => m.enabled).length} enabled — OK`,
);

const cmds = await client.command.list();
console.log(
  `commands: ${cmds.data.length} (${cmds.data
    .slice(0, 5)
    .map((c) => c.name)
    .join(", ")}) — OK`,
);

const skills = await client.skill.list();
console.log(
  `skills: ${skills.data.length} (${skills.data
    .slice(0, 5)
    .map((s) => s.name)
    .join(", ")}) — OK`,
);

const perms = await client.permission.saved.list();
console.log(
  `saved permissions: ${Array.isArray(perms.data) ? perms.data.length : (perms.data?.length ?? 0)} — OK (bare-array shape: ${Array.isArray(perms.data) ? "no" : "yes"})`,
);

const forms = await client.form.request.list();
console.log(`pending form requests: ${(forms.data ?? []).length} — OK`);

// Session-create roundtrip canary: the webview's New Session flow depends on
// a usable `id` coming back from this call (beta drift has changed shapes).
{
  const created = await client.session.create({
    location: { directory: process.cwd() },
  });
  if (!created?.id) {
    console.log("session create: NO ID IN RESPONSE — FAIL");
    process.exit(1);
  }
  console.log(`session create roundtrip: ${created.id} — OK`);
  const removed = await client.session.remove({ sessionID: created.id });
  console.log(`session remove: ${removed === undefined ? "void" : "shape?"} — OK`);
}

let branch;
try {
  const vcs = await client.vcs.get();
  const b = vcs.data?.branch;
  branch = typeof b === "string" ? b : (b?.name ?? b?.current);
} catch {
  branch = "(vcs unavailable)";
}
console.log(`vcs branch: ${branch ?? "(none)"} - OK`);

// @-mention dependency: fs.find must return a usable rows array.
try {
  const ff = await client.file.find({ query: "package.json" });
  const rows = Array.isArray(ff) ? ff : (ff?.data ?? []);
  console.log(`fs.find rows: ${rows.length} (wrapped: ${!Array.isArray(ff)}) - OK`);
} catch (e) {
  console.log(`fs.find FAILED: ${e.message}`);
  process.exit(1);
}

console.log("SMOKE PASSED");
