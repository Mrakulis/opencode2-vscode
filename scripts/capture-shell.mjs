import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

const ep = await Service.discover();
const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });

// find any session with shell history or create a tiny shell test
const sessions = await c.session.list();
let sid;
if (sessions.data.length > 0) {
  // use most recent
  const sorted = [...sessions.data].sort((a,b)=>(b.time?.updated??0)-(a.time?.updated??0));
  sid = sorted[0].id;
  console.log("using existing session", sid);
} else {
  const s = await c.session.create({});
  sid = s.id;
  console.log("created session", sid);
}

// start a shell-heavy prompt
console.log("sending prompt: run a shell loop");
const promptP = c.session.prompt({ sessionID: sid, text: "Run: for i in 1 2 3; do echo \"shell line $i\"; sleep 0.3; done" });

// tap events for 15s
const maxMs = 15000;
const start = Date.now();
let seen = 0;
for await (const evt of c.event.subscribe()) {
  const sid2 = evt.data?.sessionID ?? evt.data?.assistantMessageID ?? "?";
  // filter to our session-ish events
  if (evt.type.startsWith("session.tool") || evt.type.startsWith("session.text") || evt.type.startsWith("session.reasoning") || evt.type === "session.execution.started" || evt.type === "session.execution.succeeded" || evt.type === "session.execution.failed") {
    // only for our session
    const esid = evt.data?.sessionID;
    if (esid && esid !== sid) continue;
    console.log(Date.now()-start, evt.type, JSON.stringify(evt.data).slice(0, 600));
    seen++;
  }
  if (evt.type === "session.execution.succeeded" || evt.type === "session.execution.failed") {
    const esid2 = evt.data?.sessionID;
    if (esid2 === sid) break;
  }
  if (Date.now()-start > maxMs) break;
}
await promptP.catch(()=>{});
console.log("done seen", seen);
