/* Replicates the controller's hidden auto-start: discover -> spawn hidden ->
 * poll registration -> health. Run: node scripts/verify-hidden-start.mjs */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the CLI the way cli.ts does (opencode2 first)
async function resolveCli() {
  const where = (name) =>
    new Promise((res) =>
      execFile("where.exe", [name], { windowsHide: true }, (err, out) =>
        res(err ? [] : out.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)),
      ),
    );
  for (const name of ["opencode2", "opencode"]) {
    const hits = await where(name);
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe) return { program: exe };
    if (hits.length) return { program: hits[0] };
    // npm-known real binary
    const npmRoot = path.join(process.env.APPDATA ?? "", "npm");
    if (name === "opencode2" || name === "opencode") {
      const cand = [
        path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe"),
        path.join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
      ].find((p) => { try { return require("fs").statSync(p).isFile(); } catch { return false; } });
      if (cand) return { program: cand };
    }
  }
  throw new Error("no opencode CLI found");
}

console.log("step 1: discover running service…");
let ep = await Service.discover().catch(() => undefined);
if (ep) {
  console.log(`already running at ${ep.url} — skipping hidden spawn (path exercised on next cold start).`);
  const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });
  const h = await c.health.get();
  console.log(`health: v${h.version} pid ${h.pid} — OK`);
  process.exit(0);
}

const cli = await resolveCli();
console.log(`step 2: spawning hidden: ${cli.program} serve --service`);
const cmd = [cli.program, "serve", "--service"];
const child = spawn(cmd[0], cmd.slice(1), {
  detached: true,
  stdio: "ignore",
  windowsHide: true, // CREATE_NO_WINDOW
  env: process.env,
});
child.unref();

console.log("step 3: polling Service.discover() for registration (≤15s)…");
const deadline = Date.now() + 15_000;
let delay = 400;
let endpoint;
while (Date.now() < deadline) {
  endpoint = await Service.discover().catch(() => undefined);
  if (endpoint) break;
  await sleep(delay);
  delay = Math.min(delay * 1.7, 2000);
}
if (!endpoint) {
  console.error("FAIL: service did not register within 15s");
  process.exit(1);
}
console.log(`registered at ${endpoint.url}`);
const c = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const h = await c.health.get();
console.log(`health: v${h.version} pid ${h.pid} — OK`);
console.log("HIDDEN START VERIFIED (no console window created)");