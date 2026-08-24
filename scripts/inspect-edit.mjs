/* Find a recent edit/shell tool part and dump its shape. */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

const ep = await Service.discover();
const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });

const sessions = await c.session.list();
let shown = 0;
outer: for (const s of [...sessions.data].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))) {
  const msgs = await c.message.list({ sessionID: s.id }).catch(() => null);
  if (!msgs) continue;
  for (const m of Array.isArray(msgs.data) ? msgs.data : msgs.data?.data ?? []) {
    if (m.type !== "assistant") continue;
    for (const p of m.content ?? []) {
      if (p.type !== "tool") continue;
      const n = String(p.name ?? "").toLowerCase();
      if (!/edit|write|patch/.test(n)) continue;
      console.log("=== tool:", p.name, "| state.status:", p.state?.status);
      console.log("input keys:", Object.keys(p.state?.input ?? {}));
      console.log("input:", JSON.stringify(p.state?.input).slice(0, 500));
      console.log("content types:", (p.state?.content ?? []).map((x) => x.type).join(","));
      const d = (p.state?.content ?? []).find((x) => typeof x.diff === "string");
      console.log("has diff in content:", Boolean(d), d ? `(${d.diff.length} chars)` : "");
      if (++shown >= 3) break outer;
    }
  }
}
if (shown === 0) console.log("no edit tool parts found in recent sessions");
