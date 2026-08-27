// Probe: verify the live /session/stats shape and which input serialization
// the beta client sends correctly. Run: node scripts/stats-probe.mjs
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

console.log("== client.session.stats() (default) ==");
try {
  const res = await c.session.stats();
  console.log(
    JSON.stringify(
      {
        sessions: res.sessions,
        subagents: res.subagents,
        prompts: res.prompts,
        steps: res.steps,
        cost: res.cost,
        activeDays: res.activeDays,
        streak: res.streak,
        activityEntries: res.activity?.length,
        activityTail: res.activity?.slice(-3),
        toolsMode: res.tools?.mode,
        toolsTotals: res.tools?.totals,
        models: res.models?.map((m) => ({
          model: `${m.model.providerID}/${m.model.id}`,
          steps: m.steps,
          cost: m.cost,
          tokens: m.tokens,
        })),
      },
      null,
      1,
    ),
  );
} catch (e) {
  console.log("FAILED:", e.message);
}

console.log("== client.session.stats({ tools: { tools: 'detail' } }) ==");
try {
  const res = await c.session.stats({ tools: { tools: "detail" } });
  console.log(
    "tools.mode =",
    res.tools?.mode,
    "usage rows =",
    res.tools?.usage?.length ?? 0,
    res.tools?.usage?.slice(0, 5),
  );
} catch (e) {
  console.log("FAILED:", e.message);
}

console.log("== raw fetch (flat query) ==");
const headers = Service.headers(endpoint);
const base = String(endpoint.url).replace(/\/$/, "");
for (const p of [
  "/session/stats?tools=detail",
  "/api/session/stats?tools=detail",
]) {
  try {
    const res = await fetch(base + p, { headers });
    const body = await res.json();
    const data = body.data ?? body;
    console.log(p, res.status, "tools.mode =", data?.tools?.mode);
  } catch (e) {
    console.log(p, "FAILED:", e instanceof Error ? e.message : String(e));
  }
}
