/* Verify every [data-theme] block defines the full --oc2-* token set.
   Run: node scripts/check-themes.mjs */
import fs from "node:fs";

const css = fs.readFileSync("webview-src/styles.css", "utf8");

// Collect tokens defined in the :root base block
const rootBlock = /(^|\n):root \{([\s\S]*?)\n\}/.exec(css);
if (!rootBlock) {
  console.error("FAIL: no :root block found");
  process.exit(1);
}
const baseTokens = [...rootBlock[2].matchAll(/--oc2-[a-z0-9-]+\s*:/g)]
  .map((m) => m[0].trim())
  // Density + font tokens are theme-invariant: defined once in :root and
  // swapped via [data-density], never overridden per theme.
  .filter((t) => !/^--oc2-(font-size|space-\d|radius|mono):/.test(t));

// Parse each themed block
const blocks = [
  ...css.matchAll(/:root\[data-theme="([a-z]+)"\] \{([\s\S]*?)\n\}/g),
];
let failures = 0;
for (const [, id, body] of blocks) {
  const defined = new Set(
    [...body.matchAll(/(--oc2-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  const missing = baseTokens.filter(
    (t) => !defined.has(t.replace(/\s*:$/, "")),
  );
  if (missing.length > 0) {
    console.error(
      `FAIL ${id}: missing ${missing.length} token(s): ${missing.join(", ")}`,
    );
    failures++;
  } else {
    console.log(`OK   ${id}: all ${baseTokens.length} tokens defined`);
  }
}
console.log(
  `\n${blocks.length} presets checked against ${baseTokens.length} base tokens`,
);
process.exit(failures === 0 && blocks.length >= 4 ? 0 : 1);
