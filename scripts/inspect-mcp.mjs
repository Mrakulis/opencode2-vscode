/* Inspect live MCP + credential shapes. Run: node scripts/inspect-mcp.mjs */
import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

const ep = await Service.discover();
const c = OpenCode.make({ baseUrl: ep.url, headers: Service.headers(ep) });

const res = await c.mcp.list();
console.log("--- mcp.list ---");
console.log(JSON.stringify(res, null, 1).slice(0, 1500));

console.log("--- credential.update probe (expect validation error naming fields) ---");
try {
  await c.credential.update({});
} catch (e) {
  console.log(String(e).slice(0, 400));
}

const saved = await c.permission.saved.list();
console.log("--- permission.saved.list shape ---");
console.log(Array.isArray(saved) ? "bare array" : `wrapped: ${Object.keys(saved)}`);
