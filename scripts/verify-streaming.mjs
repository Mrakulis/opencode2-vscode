/**
 * Census of streaming events using a model that should actually stream.
 * Tries candidate reasoning-capable models until one runs to completion.
 * Run: node scripts/verify-streaming.mjs
 */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

const ep = await Service.discover();
if (!ep) {
  console.log("no service running");
  process.exit(0);
}
const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });
const models = await c.model.list();
const picks = models.data
  .filter((m) => m.enabled)
  .filter((m) =>
    /claude-sonnet|claude-opus|gpt-4|o[134]|qwen|deepseek-r1|thinking/i.test(m.id),
  )
  .filter((m) => m.providerID === "openrouter")
  .slice(0, 8);
console.log(
  "candidates:",
  picks.map((m) => `${m.providerID}/${m.id}`).join(", "),
);

for (const model of picks) {
  try {
    const session = await c.session.create({
      model: { id: model.id, providerID: model.providerID },
      location: { directory: process.cwd() },
    });
    console.log(`\n=== trying ${model.providerID}/${model.id} ===`);

    const counts = new Map();
    const samples = new Map();
    let done = false;

    const pump = (async () => {
      for await (const e of c.event.subscribe()) {
        counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
        if (!samples.has(e.type) && typeof e.data === "object" && e.data !== null) samples.set(e.type, e.data);
        if (
          (e.type === "session.execution.succeeded" ||
            e.type === "session.execution.failed" ||
            e.type === "session.execution.interrupted") &&
          e.data?.sessionID === session.id
        ) {
          done = true;
          break;
        }
      }
    })();

    await c.session.prompt({ sessionID: session.id, text: "Think out loud step by step, then answer: what is 7*9?" });
    const deadline = Date.now() + 240_000;
    while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 400));
    await Promise.race([pump, new Promise((r) => setTimeout(r, 800))]);

    console.log("census:");
    for (const [t, n] of [...counts.entries()].sort()) {
      if (t.startsWith("session.")) console.log(`${String(n).padStart(3)} ${t}`);
    }
    for (const [t, d] of samples.entries()) {
      if (t.endsWith(".delta")) console.log(t, "→", JSON.stringify(d).slice(0, 180));
    }
    if (done && counts.get("session.execution.succeeded")) {
      console.log("GOT A COMPLETED RUN — deltas seen:", [...counts.keys()].filter((k) => k.endsWith(".delta")));
      break;
    }
  } catch (e) {
    console.log("error on", model.id, String(e).slice(0, 120));
  }
}