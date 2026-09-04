/* Live verification: trigger the agent `question` tool and confirm the full
 * pipeline the webview depends on — (1) the question parks with a parseable
 * input + options, (2) interrupt + session.wait un-parks the run, (3) a
 * follow-up chat message (the button-equivalent answer) starts a clean turn.
 * Run: node scripts/question-probe.mjs
 */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

// Mirror src/directory.ts (mjs cannot import TS): uppercase win32 drive letter.
function canonicalizeDirectory(dir) {
  if (process.platform !== "win32") return dir;
  return path.normalize(dir).replace(/^[a-z](?=:)/, (c) => c.toUpperCase());
}

// Inline mirror of webview-src/lib/questions.ts parseQuestionInput.
function parseQuestionInput(input) {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const questions = raw.questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter(
    (q) => !!q && typeof q === "object" && !Array.isArray(q),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client;
if (process.env.OPENCODE_BASE_URL) {
  client = OpenCode.make({ baseUrl: process.env.OPENCODE_BASE_URL });
  console.log(`target: ${process.env.OPENCODE_BASE_URL} (env)`);
} else {
  const endpoint = await Service.discover();
  if (!endpoint) {
    console.log("QUESTION-PROBE: no running service. Start opencode2 first.");
    process.exit(0);
  }
  client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  console.log(`target: ${endpoint.url} (discovered)`);
}

const health = await client.health.get();
console.log(`health: v${health.version} pid ${health.pid}`);

const models = await client.model.list();
const modelRows = Array.isArray(models) ? models : models.data ?? [];
const zen = modelRows.filter((m) => {
  if (m.providerID !== "opencode" || m.enabled === false) return false;
  const costRows = Array.isArray(m.cost) ? m.cost : [m.cost];
  return costRows.length > 0 && costRows.every((c) => c && Number(c.input) === 0 && Number(c.output) === 0);
});
const preferred = zen.find((m) => m.id === "big-pickle") ?? zen[0];
console.log(`model: ${preferred ? `${preferred.providerID}/${preferred.id}` : "(server default)"}`);

const dir = mkdtempSync(join(tmpdir(), "oc2-qprobe-"));
const created = await client.session.create({
  location: { directory: canonicalizeDirectory(dir) },
  agent: "build",
  ...(preferred ? { model: { id: preferred.id, providerID: preferred.providerID } } : {}),
});
console.log(`session: ${created.id}`);

await client.session.prompt({
  sessionID: created.id,
  text:
    "Use the question tool to ask me exactly one question: which database backend should we use? " +
    "Offer exactly these options: Postgres, SQLite, MySQL. Then stop.",
});

// 1) Wait for the question to park with a parseable input (the exact check
//    `isParkedQuestionWithData` performs in the webview).
let ok = false;
const d0 = Date.now() + 90_000;
while (Date.now() < d0) {
  await sleep(1500);
  const msgs = await client.message.list({ sessionID: created.id });
  const rows = Array.isArray(msgs) ? msgs : msgs.data ?? [];
  outer: for (const m of rows) {
    if (m.type !== "assistant") continue;
    for (const p of m.content ?? []) {
      if (!(p && p.type === "tool" && p.name === "question")) continue;
      const parsed = parseQuestionInput(p.state?.input);
      console.log(`question part: status=${p.state?.status} input=${JSON.stringify(p.state?.input)}`);
      if (parsed.length > 0 && Array.isArray(parsed[0].options) && parsed[0].options.length > 0) {
        console.log(`  parsed ${parsed.length} question(s), options=[${parsed[0].options.map((o) => o.label).join(", ")}] → buttons render`);
        ok = true;
        break outer;
      }
    }
  }
  if (ok) break;
}
console.log(`1. question parks with parseable options: ${ok ? "PASS" : "FAIL"}`);

// 2) Interrupt + wait (the exact sequence the extension's `prompt.interrupt`
//    RPC now performs) and confirm the session leaves the active set.
await client.session.interrupt({ sessionID: created.id }).catch((e) => console.log(`  interrupt rejected: ${e.message}`));
await client.session.wait({ sessionID: created.id }).catch(() => {});
await sleep(1000);
let active = [];
try {
  const a = await client.session.active();
  const rec = a?.data ?? a ?? {};
  active = Array.isArray(rec)
    ? rec.map((r) => r.id).filter(Boolean)
    : Object.entries(rec).filter(([, v]) => (v?.type ?? v) === "running").map(([k]) => k);
} catch {
  /* ignore */
}
console.log(`2. interrupt + wait un-parks: ${active.includes(created.id) ? "FAIL" : "PASS"}`);

// 3) Send the answer as a plain chat message (button-equivalent) and expect a
//    fresh assistant turn that is NOT "Step interrupted".
const before = await (async () => {
  const msgs = await client.message.list({ sessionID: created.id });
  const rows = Array.isArray(msgs) ? msgs : msgs.data ?? [];
  return rows.filter((m) => m.type === "assistant").length;
})();
await client.session.prompt({ sessionID: created.id, text: "Postgres" });
let answer = "NO NEW TURN";
const d1 = Date.now() + 60_000;
while (Date.now() < d1) {
  await sleep(2000);
  const msgs = await client.message.list({ sessionID: created.id });
  const rows = Array.isArray(msgs) ? msgs : msgs.data ?? [];
  const assistants = rows.filter((m) => m.type === "assistant");
  const fresh = assistants.slice(before);
  const last = fresh[fresh.length - 1];
  if (!last) continue;
  if (last.finish && last.finish !== "running" && last.finish !== "streaming") {
    const texts = (last.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 120);
    const clean = last.finish !== "error";
    answer = `finish=${last.finish} err=${JSON.stringify(last.error?.message ?? last.error?.type ?? null)} text="${texts}"`;
    console.log(`3. answer starts a clean turn: ${clean ? "PASS" : "FAIL"} (${answer})`);
    break;
  }
}
if (answer === "NO NEW TURN") console.log("3. answer starts a clean turn: FAIL (no completed turn)");

await client.session.remove({ sessionID: created.id }).catch(() => {});
console.log("QUESTION-PROBE DONE");
process.exit(0);
