/* Live smoke test against the real V2 service. Run: node scripts/smoke.mjs
 *
 * Target resolution:
 *   1. OPENCODE_BASE_URL env (used by CI's integration job against a freshly
 *      booted beta server)
 *   2. Service.discover() — the local registered background service
 */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
import path from "node:path";

// Mirror src/directory.ts (mjs cannot import TS): uppercase win32 drive letter
// so the canary never creates a poisoned session on lowercase-drive checkouts.
function canonicalizeDirectory(dir) {
  if (process.platform !== "win32") return dir;
  return path.normalize(dir).replace(/^[a-z](?=:)/, (c) => c.toUpperCase());
}

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

// Session-create + PROMPT canary: the webview's New Session flow depends on
// both a usable `id` coming back from this call AND a model binding that can
// actually run (P0 incident 2026-08-26: fresh sessions bound to a blocked
// server default failed every prompt, silently). We create with an explicit,
// catalog-validated free Zen model, prompt it, and classify the outcome.
{
  const rows = Array.isArray(models.data) ? models.data : models.data ?? [];
  const zen = rows.filter((m) => {
    if (m.providerID !== "opencode" || m.enabled === false) return false;
    const costRows = Array.isArray(m.cost) ? m.cost : [m.cost];
    return (
      costRows.length > 0 &&
      costRows.every((c) => c && Number(c.input) === 0 && Number(c.output) === 0)
    );
  });
  const preferred =
    zen.find((m) => m.id === "big-pickle") ?? zen[0] ?? undefined;
  const created = await client.session.create({
    location: { directory: canonicalizeDirectory(process.cwd()) },
    ...(preferred
      ? { model: { id: preferred.id, providerID: preferred.providerID } }
      : {}),
  });
  if (!created?.id) {
    console.log("session create: NO ID IN RESPONSE — FAIL");
    process.exit(1);
  }
  console.log(
    `session create roundtrip: ${created.id} (model: ${preferred ? `${preferred.providerID}/${preferred.id}` : "(server default)"}) — OK`,
  );

  // Prompt the canary and wait for the run to settle.
  let verdict = "NO ASSISTANT MESSAGE";
  try {
    await client.session.prompt({
      sessionID: created.id,
      text: "Reply with exactly: PING",
    });
    const deadline = Date.now() + 60_000;
    poll: while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let msgs;
      try {
        msgs = await client.message.list({ sessionID: created.id });
      } catch {
        continue; // transient list failure — keep polling
      }
      const rowsM = Array.isArray(msgs) ? msgs : msgs.data ?? [];
      const assistants = rowsM.filter((m) => m.type === "assistant");
      const lastA = assistants[assistants.length - 1];
      if (!lastA) continue;
      if (lastA.finish === "error") {
        const em = lastA.error?.message ?? lastA.error?.type ?? "unknown";
        if (
          /provider|invalid-request|policy|guardrail|no endpoints/i.test(String(em))
        ) {
          verdict = `PROVIDER FAILURE on ${lastA.model?.providerID}/${lastA.model?.id}: ${em} — check provider settings/privacy policy or bind a working default model`;
        } else {
          verdict = `STEP ERROR: ${em}`;
        }
        break poll;
      }
      if (lastA.finish && lastA.finish !== "error") {
        const texts = (lastA.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(" ");
        verdict = `REPLIED (${lastA.finish}): "${texts.trim().slice(0, 80)}"`;
        break poll;
      }
    }
  } catch (e) {
    verdict = `PROMPT CALL FAILED: ${e.message}`;
  }
  console.log(`session prompt canary: ${verdict}`);
  const ok = /^REPLIED/.test(verdict);
  const removed = await client.session.remove({ sessionID: created.id });
  console.log(`session remove: ${removed === undefined ? "void" : "shape?"} — OK`);
  if (!ok) {
    console.log("SMOKE FAILED (prompt canary did not produce a healthy reply)");
    process.exit(1);
  }
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
