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
        res(
          err
            ? []
            : out
                .toString()
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean),
        ),
      ),
    );
  for (const name of ["opencode2", "opencode"]) {
    const hits = await where(name);
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe) return { program: exe };
    if (hits.length) return { program: hits[0] };
    // npm-known binaries — expanded set mirrors src/locations.ts win32 list
    const npmRoot = path.join(process.env.APPDATA ?? "", "npm");
    if (name === "opencode2" || name === "opencode") {
      const cand = [
        path.join(npmRoot, `${name}.exe`),
        path.join(npmRoot, `${name}.cmd`),
        path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", `${name}.exe`),
        path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", name),
        path.join(npmRoot, "node_modules", "opencode-ai", "bin", `${name}.exe`),
        path.join(npmRoot, "node_modules", "opencode-ai", "bin", name),
        path.join(npmRoot, "node_modules", "@opencode-ai", "cli", "bin", "opencode2.exe"),
        path.join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
      ].find((p) => {
        try {
          return require("fs").statSync(p).isFile();
        } catch {
          return false;
        }
      });
      if (cand) return { program: cand };
    }
  }
  throw new Error("no opencode CLI found");
}

console.log("step 1: discover running service…");
let ep = await Service.discover().catch(() => undefined);
if (ep) {
  console.log(
    `already running at ${ep.url} — skipping hidden spawn (path exercised on next cold start).`,
  );
  const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });
  const h = await c.health.get();
  console.log(`health: v${h.version} pid ${h.pid} — OK`);
  process.exit(0);
}

const cli = await resolveCli();
// Shim-aware hidden spawn mirrors src/controller.ts:startHiddenService:
// - real exe/node → direct spawn with windowsHide
// - .cmd shim → sibling exe check → node-direct parse → cmd.exe /d /s /c fallback
let cmd;
let spawnOpts = { detached: true, stdio: "ignore", windowsHide: true, shell: false, env: process.env };
if (/\.cmd$/i.test(cli.program)) {
  const siblingExe = cli.program.replace(/\.cmd$/i, ".exe");
  try {
    if (require("fs").statSync(siblingExe).isFile()) {
      console.log(`step 2: shim ${cli.program} has sibling exe → spawning hidden: ${siblingExe} serve --service`);
      cmd = [siblingExe, "serve", "--service"];
    } else throw new Error("no sibling");
  } catch {
    // try parsing shim for direct node target (same logic as src/cli.ts describe)
    let direct = null;
    try {
      const content = require("fs").readFileSync(cli.program, "utf8");
      const m = content.match(/"%~dp0\\([^"]+)"/);
      if (m?.[1]) {
        const target = path.join(path.dirname(cli.program), m[1].replace(/\//g, path.sep));
        if (require("fs").statSync(target).isFile()) {
          direct = target;
          const nodeExe = path.join(path.dirname(cli.program), "node.exe");
          let nodeProg = "node";
          try { if (require("fs").statSync(nodeExe).isFile()) nodeProg = nodeExe; } catch {}
          if (/\.js$/i.test(target) || !/\.exe$/i.test(target)) {
            console.log(`step 2: shim ${cli.program} → parsed direct node target → spawning hidden: ${nodeProg} ${target} serve --service`);
            cmd = [nodeProg, target, "serve", "--service"];
          } else {
            console.log(`step 2: shim ${cli.program} → parsed exe target → spawning hidden: ${target} serve --service`);
            cmd = [target, "serve", "--service"];
          }
        }
      }
    } catch {}
    if (!direct) {
      console.log(`step 2: spawning hidden via cmd shim: cmd.exe /d /s /c "${cli.program} serve --service"`);
      cmd = ["cmd.exe", "/d", "/s", "/c", `"${cli.program}" serve --service`];
    }
  }
} else {
  console.log(`step 2: spawning hidden: ${cli.program} serve --service`);
  cmd = [cli.program, "serve", "--service"];
}
console.log(`  spawn: ${cmd.join(" ")} with windowsHide:true shell:false`);
const child = spawn(cmd[0], cmd.slice(1), {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  shell: false,
  windowsVerbatimArguments: false,
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
const c = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
});
const h = await c.health.get();
console.log(`health: v${h.version} pid ${h.pid} — OK`);
console.log("HIDDEN START VERIFIED (no console window created)");
