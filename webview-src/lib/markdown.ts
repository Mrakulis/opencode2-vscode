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

/** True when inline `code` text looks like a file path that can be opened. */
function isFileLikeMarkdownCode(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /^[\w\-./\\]+:\d+/.test(t) ||
    /^[\w\-./\\]+\.(ts|tsx|js|jsx|json|md|css|scss|html|rs|py|go|java|rb|php|yaml|yml|toml|sh|ps1|sql|vue|svelte)\b/i.test(t)
  );
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
  // Annotate file-like inline `code` so only those look clickable (Feed handleFileClick checks same pattern)
  const origCodespan = renderer.codespan.bind(renderer) as (...args: unknown[]) => string;
  (renderer as unknown as { codespan: (...args: unknown[]) => string }).codespan = (
    ...args: unknown[]
  ): string => {
    let txt = "";
    if (
      args.length === 1 &&
      typeof args[0] === "object" &&
      args[0] !== null &&
      "text" in (args[0] as Record<string, unknown>)
    ) {
      const t = (args[0] as { text?: unknown }).text;
      txt = typeof t === "string" ? t : "";
    } else if (typeof args[0] === "string") {
      txt = args[0] as string;
    }
    const base = origCodespan(...args);
    if (isFileLikeMarkdownCode(txt)) {
      // inject file-link class: <code> -> <code class="file-link">
      return base.replace("<code>", '<code class="file-link">');
    }
    return base;
  };
  // External links should be identifiable; ensure target is preserved for a11y
  const origLink = renderer.link.bind(renderer) as (...args: unknown[]) => string;
  (renderer as unknown as { link: (...args: unknown[]) => string }).link = (
    ...args: unknown[]
  ): string => {
    const base = origLink(...args);
    // If href is http(s)/mailto/vscode, ensure target blank is present (sanitizer allows it)
    // marked already escapes href; just inject target if missing
    if (/href="https?:\/\//i.test(base) || /href="mailto:/i.test(base) || /href="vscode:/i.test(base)) {
      if (!/target=/.test(base)) return base.replace("<a ", '<a target="_blank" rel="noopener" ');
    }
    return base;
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
