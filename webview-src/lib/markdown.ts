import { marked } from "marked";
import DOMPurify from "dompurify";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDiffBlock(text: string): string {
  const lines = text.split(/\r?\n/);
  // marked may add trailing newline; keep structure but avoid extra empty line
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const htmlLines = lines
    .map((l) => {
      const esc = escapeHtml(l);
      let cls: string;
      if (
        l.startsWith("@@") ||
        l.startsWith("diff ") ||
        l.startsWith("index ")
      )
        cls = "meta";
      else if (l.startsWith("+")) cls = "add";
      else if (l.startsWith("-")) cls = "del";
      else cls = "ctx";
      // preserve empty lines so background still renders
      return `<span class="diff-line ${cls}">${esc || " "}</span>`;
    })
    .join("\n");
  return `<pre class="diff md-diff"><code>${htmlLines}</code></pre>`;
}

/** Markdown -> sanitized HTML. Code blocks keep plain <pre><code> styling. */
export function renderMarkdown(text: string): string {
  const renderer = new marked.Renderer();
  const origCode = renderer.code.bind(renderer) as (...args: unknown[]) => string;
  (renderer as unknown as { code: (...args: unknown[]) => string }).code = (
    ...args: unknown[]
  ): string => {
    let codeText = "";
    let lang: string | undefined;
    let tokenObj: unknown = null;
    if (
      args.length === 1 &&
      typeof args[0] === "object" &&
      args[0] !== null &&
      "text" in (args[0] as Record<string, unknown>)
    ) {
      tokenObj = args[0];
      const t = tokenObj as { text?: unknown; lang?: unknown };
      codeText = typeof t.text === "string" ? t.text : "";
      lang = typeof t.lang === "string" ? t.lang : undefined;
    } else {
      codeText = typeof args[0] === "string" ? (args[0] as string) : "";
      lang = typeof args[1] === "string" ? (args[1] as string) : undefined;
    }
    const normalized = (lang ?? "").trim().toLowerCase();
    if (normalized === "diff" || normalized === "patch") {
      return renderDiffBlock(codeText);
    }
    if (tokenObj) return origCode(tokenObj);
    return origCode(codeText, lang, !!args[2]);
  };

  const html = marked.parse(text, {
    async: false,
    gfm: true,
    breaks: true,
    renderer,
  }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "input", "form"],
    ADD_ATTR: ["target", "class"],
  });
}
