// One-off probe: capture the real permission.asked payload for an edit action.
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const endpoint = await Service.discover();
if (!endpoint) { console.log("no service"); process.exit(1); }
const c = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });

const dir = mkdtempSync(join(tmpdir(), "oc2-probe-"));
// Force the edit permission to ask so we capture a real permission.asked payload.
writeFileSync(
  join(dir, "opencode.jsonc"),
  JSON.stringify(
    { $schema: "https://opencode.ai/config.json", permissions: [{ action: "edit", resource: "*", effect: "ask" }] },
    null,
    1,
  ),
);
console.log("workspace:", dir);

const done = Promise.withResolvers();
const timeout = setTimeout(() => done.reject(new Error("timeout waiting for permission")), 120_000);

(async () => {
  for await (const ev of c.event.subscribe()) {
    if (ev.type === "permission.asked") {
      console.log("PERMISSION.ASKED PAYLOAD:");
      console.log(JSON.stringify(ev.data, null, 1));
      // Reject so nothing lands on disk.
      const d = ev.data;
      await c.permission.reply({ sessionID: d.sessionID, requestID: d.id ?? d.requestID, reply: "reject" }).catch((e) => console.log("reply failed", e.message));
    }
    if (ev.type === "session.execution.failed" || ev.type === "session.idle" || ev.type === "session.execution.succeeded") {
      clearTimeout(timeout);
      done.resolve();
      break;
    }
  }
})();

const created = await c.session.create({
  location: { directory: dir },
  model: { providerID: "opencode", id: "big-pickle" },
});
console.log("session:", created.id);
await c.session.prompt({
  sessionID: created.id,
  text: "Use the write tool to create a file named oc2-probe.txt with exactly this content: hello",
});
await done.promise;
await c.session.remove({ sessionID: created.id }).catch(() => {});
console.log("PROBE DONE");
process.exit(0);
