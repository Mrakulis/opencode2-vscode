import * as vscode from "vscode";

/**
 * Read-only working-tree diff viewer.
 * Untitled `openTextDocument({content})` prompts to save on close — instead
 * serve the diff via a TextDocumentContentProvider over `opencode-working-diff:`
 * (like DiffPreviewDocs does for pre-apply diffs). Documents are read-only,
 * preview=true, no save dialog.
 */
export class WorkingDiffDocs implements vscode.Disposable {
  private readonly entries = new Map<string, string>();
  private counter = 0;

  private readonly provider = vscode.workspace.registerTextDocumentContentProvider(
    "opencode-working-diff",
    {
      provideTextDocumentContent: (uri: vscode.Uri): string =>
        this.entries.get(uri.query) ?? "",
    },
  );

  async show(diff: string, title = "OpenCode Working Diff"): Promise<boolean> {
    while (this.entries.size >= 20) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const key = `wd-${Date.now()}-${this.counter++}`;
    this.entries.set(key, diff || "(no changes)");
    const uri = vscode.Uri.from({
      scheme: "opencode-working-diff",
      path: "/working-diff.diff",
      query: key,
    });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
    return true;
  }

  dispose(): void {
    this.provider.dispose();
    this.entries.clear();
  }
}
