import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
const ep = await Service.discover();
const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });
const s = await c.session.create({});
console.log("sid", s.id);
const p = c.session.prompt({ sessionID: s.id, text: "Write a file /tmp/oc2-write-test.txt with exactly 20 lines, each 'line N'" });
let sawInputDelta = false;
const sub = c.event.subscribe();
const to = setTimeout(()=>{ console.log("timeout"); process.exit(0);}, 20000);
for await (const e of sub) {
  if (e.type.includes("tool.input") || e.type.includes("tool.progress")) {
    console.log(e.type, JSON.stringify(e.data).slice(0, 500));
    if (e.type === "session.tool.input.delta") sawInputDelta = true;
  }
  if (e.type === "session.execution.succeeded" || e.type === "session.execution.failed") {
    console.log("terminal", e.type);
    break;
  }
}
await p.catch(()=>{});
console.log("sawInputDelta", sawInputDelta);
clearTimeout(to);
