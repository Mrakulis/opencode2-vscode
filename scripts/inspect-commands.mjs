/* Dump the full command catalog + where custom commands come from. */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ep = await Service.discover();
const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });

const cmds = await c.command.list();
console.log(`--- command.list(): ${cmds.data.length} returned ---`);
for (const cmd of cmds.data) {
  console.log(`  /${cmd.name}${cmd.description ? ` — ${cmd.description.slice(0, 70)}` : ""}`);
  console.log(`    template: ${JSON.stringify(cmd.template?.slice(0, 80))}`);
}

console.log("\n--- command source directories ---");
for (const dir of [
  path.join(os.homedir(), ".config", "opencode", "command"),
  path.join(os.homedir(), ".config", "opencode", "commands"),
  path.join(process.cwd(), ".opencode", "command"),
  path.join(process.cwd(), ".opencode", "commands"),
]) {
  if (fs.existsSync(dir)) {
    console.log(`${dir}:`, fs.readdirSync(dir).join(", "));
  } else {
    console.log(`${dir}: (missing)`);
  }
}

// Any inline commands in global opencode.json?
for (const f of ["opencode.json", "opencode.jsonc"]) {
  const p = path.join(os.homedir(), ".config", "opencode", f);
  if (fs.existsSync(p)) {
    const txt = fs.readFileSync(p, "utf8");
    console.log(`\n${p} has "commands" key: ${/"commands"\s*:/.test(txt)}`);
  }
}
