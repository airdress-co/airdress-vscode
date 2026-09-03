/**
 * Manifest diff flow: fetch live -> virtual document -> vscode.diff -> apply.
 *
 * TODO(SPEC-057 T6-05): implement a TextDocumentContentProvider for the
 * live manifest, open it against the local file with vscode.diff, and
 * gate apply behind an explicit confirmation.
 */

export async function diffAgainstLive(_localUri: unknown): Promise<void> {
  throw new Error("TODO(SPEC-057 T6-05): manifest diff not implemented");
}
