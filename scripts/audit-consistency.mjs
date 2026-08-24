/* Consistency audit: protocol RpcMethod <-> rpc.ts handlers <-> CSS classes */
import fs from "node:fs";

const proto = fs.readFileSync("src/protocol.ts", "utf8");
const rpc = fs.readFileSync("src/rpc.ts", "utf8");
const css = fs.readFileSync("webview-src/styles.css", "utf8");
const tsxFiles = ["Composer.tsx", "Feed.tsx", "FormCard.tsx", "HeaderBar.tsx", "InboxDrawer.tsx", "InstructionsDrawer.tsx", "McpDrawer.tsx", "ModelManager.tsx", "ProvidersDrawer.tsx", "SavedPermissionsDrawer.tsx", "SessionsDrawer.tsx", "StatusStrip.tsx", "WorktreesDrawer.tsx"]
  .map((f) => fs.readFileSync(`webview-src/components/${f}`, "utf8"))
  .join("\n");
const app = fs.readFileSync("webview-src/App.tsx", "utf8");
const all = tsxFiles + app;

// 1) RpcMethod union members
const unionBlock = proto.match(/export type RpcMethod =[\s\S]*?;/)?.[0] ?? "";
const methods = [...unionBlock.matchAll(/\|\s*"([a-z.A-Z]+)"/g)].map((m) => m[1]);
console.log(`union methods: ${methods.length}`);

// 2) handlers defined in rpc.ts ("name": pattern)
const handlers = new Set([...rpc.matchAll(/"([a-z.A-Z]+)":\s*(?:\(|async)/g)].map((m) => m[1]));

// rpc calls made from webview
const calledFromWebview = new Set(
  [...all.matchAll(/rpc\.call(?:<[^>]*>)?\(\s*"([a-z.A-Z]+)"/g)].map((m) => m[1]),
);
// calls made host-side (extension.ts / sidebarProvider use api directly, skip)

let problems = 0;
for (const m of methods) {
  if (!handlers.has(m)) {
    console.log(`MISSING HANDLER: ${m}`);
    problems++;
  }
}
for (const h of handlers) {
  if (!methods.includes(h)) console.log(`HANDLER NOT IN UNION: ${h}`);
}
for (const c of calledFromWebview) {
  if (!methods.includes(c)) console.log(`WEBVIEW CALLS UNKNOWN METHOD: ${c}`);
}
console.log("rpc surface checked.");

// 3) CSS classes defined but never referenced in TSX
const cssClasses = [...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)\s*[,{]/g)].map((m) => m[1]);
const uniq = [...new Set(cssClasses)];
const dynamicOk = new Set([
  // composed at runtime: st-${status}, kind-${kind}, line-${cls}, conn-${state}
  "st", "kind", "line", "sel", "on", "off", "ok", "err", "warn", "dim", "hot", "full",
  "conn-connected", "conn-error", "conn-connecting",
  "kind-edit", "kind-shell", "kind-other", "kind-read",
  "del", "meta", "ctx", "add",
]);
for (const cls of uniq) {
  if (dynamicOk.has(cls)) continue;
  // token must appear literally somewhere in webview/app source
  const rx = new RegExp(`\\b${cls.replace(/[-]/g, "\\-")}\\b`);
  if (!rx.test(all)) {
    console.log(`CSS ORPHAN?: .${cls}`);
    problems++;
  }
}
console.log(`css classes checked: ${uniq.length}`);
console.log(problems === 0 ? "CLEAN" : `${problems} finding(s)`);
