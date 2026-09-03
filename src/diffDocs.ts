import * as vscode from "vscode";
import path from "node:path";
import {
  applyUnifiedPatch,
  extractAddedContent,
  type WireFileDiff,
} from "./diffPatch";

export type { WireFileDiff } from "./diffPatch";

/**
 * Pre-apply diff previews (Module 1).
 *
 * Renders server-provided proposed changes (edit-permission metadata) as
 * native VS Code side-by-side diffs BEFORE anything touches disk:
 *
 *   left  = current on-disk content (empty for status "added")
 *   right = proposed content (patch applied in memory)
 *
 * The proposed content is served by a TextDocumentContentProvider over the
 * private `opencode-diff:` scheme; documents are keyed and pruned so answered
 * permissions cannot leak stale previews.
 */

interface PreviewEntry {
  /** Proposed (post-patch) content. */
  content: string;
}

export class DiffPreviewDocs implements vscode.Disposable {
  private readonly entries = new Map<string, PreviewEntry>();
  private counter = 0;

  private readonly provider =
    vscode.workspace.registerTextDocumentContentProvider(
      "opencode-diff",
      {
        provideTextDocumentContent: (uri: vscode.Uri): string =>
          this.entries.get(uri.query)?.content ?? "",
      },
    );

  /**
   * Open a native side-by-side diff for one proposed change. Falls back to
   * showing the raw patch when it cannot be applied cleanly.
   */
  async preview(fileDiff: WireFileDiff): Promise<boolean> {
    const baseDir =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const abs = path.isAbsolute(fileDiff.file)
      ? fileDiff.file
      : path.join(baseDir, fileDiff.file);
    const fileUri = vscode.Uri.file(abs);

    let original = "";
    try {
      original = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(fileUri),
      );
    } catch {
      original = ""; // new file (status "added") or unreadable — treat as empty
    }

    const proposed =
      fileDiff.status === "added"
        ? extractAddedContent(fileDiff.patch)
        : applyUnifiedPatch(original, fileDiff.patch);

    const title = `OpenCode Proposed: ${path.basename(abs)}${
      typeof fileDiff.additions === "number" ||
      typeof fileDiff.deletions === "number"
        ? `  (+${fileDiff.additions ?? 0} −${fileDiff.deletions ?? 0})`
        : ""
    }`;

    if (proposed === undefined || proposed === null) {
      // Context mismatch — show the raw patch as a read-only document instead
      // of guessing wrong content.
      const doc = await vscode.workspace.openTextDocument({
        language: "diff",
        content: fileDiff.patch,
      });
      await vscode.window.showTextDocument(doc, { preview: false });
      return true;
    }

    // Keep only the last 20 previews around (bounded memory).
    while (this.entries.size >= 20) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const key = `prev-${Date.now()}-${this.counter++}`;
    this.entries.set(key, { content: proposed });

    const ext = path.extname(abs).replace(".", "");
    const proposedUri = vscode.Uri.from({
      scheme: "opencode-diff",
      path: `/${path.basename(abs)}.${ext || "txt"}`,
      query: key,
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      fileUri,
      proposedUri,
      title,
    );
    return true;
  }

  dispose(): void {
    this.provider.dispose();
    this.entries.clear();
  }
}
