import { marked } from "marked";
import DOMPurify from "dompurify";

/** Markdown -> sanitized HTML. Code blocks keep plain <pre><code> styling. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "input", "form"],
    ADD_ATTR: ["target"],
  });
}
