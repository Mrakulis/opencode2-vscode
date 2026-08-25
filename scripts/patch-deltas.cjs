/* One-shot patch: replace lines 479..525 (1-based) of App.tsx. */
const fs = require("fs");
const p = "webview-src/App.tsx";
const lines = fs.readFileSync(p, "utf8").split("\n");

const START = 479; // 1-based
const END = 525;   // 1-based inclusive

if (!lines[START - 1].includes("activeIdRef.current")) {
  console.error("Anchor mismatch at line", START, ":", JSON.stringify(lines[START - 1]));
  process.exit(1);
}
if (lines[END - 1].trim() !== "}") {
  console.error("End anchor mismatch at line", END, ":", JSON.stringify(lines[END - 1]));
  process.exit(1);
}

const repl = [
  '          if (sid && sid === activeIdRef.current) {',
  '            const wantsMessages = actions.includes("messages");',
  '            const isDelta =',
  '              evt.type === "session.text.delta" ||',
  '              evt.type === "session.reasoning.delta";',
  '',
  '            // ALWAYS accumulate deltas — including chunks that arrive before',
  '            // the assistant message exists in our cache. Dropping those is',
  '            // what used to lose the start of the thinking.',
  '            if (isDelta) {',
  '              const d = evt.data as DeltaEvent["data"];',
  '              const id = d?.assistantMessageID ?? d?.messageID;',
  '              const chunk =',
  '                typeof d?.delta === "string"',
  '                  ? d.delta',
  '                  : typeof d?.text === "string"',
  '                    ? d.text',
  '                    : undefined;',
  '              if (id && chunk) {',
  '                const kind = evt.type === "session.reasoning.delta" ? "reasoning" : "text";',
  '                const key = `${id}|${kind}`;',
  '                deltaAccRef.current.set(key, (deltaAccRef.current.get(key) ?? "") + chunk);',
  '              }',
  '            }',
  '',
  '            // Try the incremental accumulator first for a smooth stream.',
  '            const merged = applyDelta(messagesRef.current, {',
  '              type: evt.type,',
  '              data: evt.data as DeltaEvent["data"],',
  '            });',
  '            if (merged) {',
  '              messagesRef.current = merged;',
  '              setMessages(merged);',
  '            } else if (wantsMessages || isTerminal || isDelta) {',
  '              clearTimeout(messageTimer);',
  '              messageTimer = setTimeout(',
  '                () => void refreshMessages(sid),',
  '                isDelta ? 80 : 120,',
  '              );',
  '            }',
];

lines.splice(START - 1, END - START + 1, ...repl);
fs.writeFileSync(p, lines.join("\n"));
console.log(`patched lines ${START}..${END}`);
