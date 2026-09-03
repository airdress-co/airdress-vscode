import * as vscode from "vscode";

export const AIRDRESS_SCHEME = "airdress";

/**
 * Read-only virtual documents for live operator state (design §5.1).
 *
 * URIs look like `airdress://<profile-id>/<kind>/<name>.yaml`. Content
 * lives in memory only — opening a resource writes nothing to disk —
 * and the scheme has no registered write path, so the documents are
 * structurally read-only.
 */
export class LiveManifestProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  static uriFor(profileId: string, kind: string, name: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: AIRDRESS_SCHEME,
      authority: profileId,
      path: `/${encodeURIComponent(kind)}/${encodeURIComponent(name)}.yaml`,
    });
  }

  /** Scheme-agnostic key: authority (profile) + path (kind/name). */
  private static key(uri: vscode.Uri): string {
    return `${uri.authority}${uri.path}`;
  }

  /** Publish (or refresh) live content for a resource; returns its URI. */
  publish(
    profileId: string,
    kind: string,
    name: string,
    content: string,
  ): vscode.Uri {
    const uri = LiveManifestProvider.uriFor(profileId, kind, name);
    this.contents.set(LiveManifestProvider.key(uri), content);
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return (
      this.contents.get(LiveManifestProvider.key(uri)) ??
      "# No live content fetched for this resource yet."
    );
  }
}
