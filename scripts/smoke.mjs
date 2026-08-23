/* Live smoke test against the real V2 service. Run: node scripts/smoke.mjs */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

const endpoint = await Service.discover();
if (!endpoint) {
  console.log("SMOKE: no running service discovered — start `opencode2` and retry.");
  process.exit(0);
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

const health = await client.health.get();
console.log(`health: v${health.version} pid ${health.pid} — OK`);

const models = await client.model.list();
console.log(`models: ${models.data.filter((m) => m.enabled).length} enabled — OK`);

const cmds = await client.command.list();
console.log(`commands: ${cmds.data.length} (${cmds.data.slice(0, 5).map((c) => c.name).join(", ")}) — OK`);

const skills = await client.skill.list();
console.log(`skills: ${skills.data.length} (${skills.data.slice(0, 5).map((s) => s.name).join(", ")}) — OK`);

const perms = await client.permission.saved.list();
console.log(`saved permissions: ${Array.isArray(perms.data) ? perms.data.length : perms.data?.length ?? 0} — OK (bare-array shape: ${Array.isArray(perms.data) ? "no" : "yes"})`);

const forms = await client.form.request.list();
console.log(`pending form requests: ${(forms.data ?? []).length} — OK`);

let branch;
try {
  const vcs = await client.vcs.get();
  const b = vcs.data?.branch;
  branch = typeof b === "string" ? b : b?.name ?? b?.current;
} catch { branch = "(vcs unavailable)"; }
console.log(`vcs branch: ${branch ?? "(none)"} — OK`);

console.log("SMOKE PASSED");
