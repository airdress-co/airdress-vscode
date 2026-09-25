import * as vscode from "vscode";
import { MANIFEST_FILE } from "./local";
import type { SourceRefusal } from "./wire";

/**
 * A source refusal, as editor markers.
 *
 * The operator names where a refusal points — an archive path, a 1-based
 * line, a 1-based column — so the marker lands on the line that caused
 * it without this side parsing a message. Nothing is inferred: a
 * location with no line marks the file's first line, and a refusal with
 * no location marks nothing (the caller says it in words instead).
 */

/** The diagnostic `source`, shown beside every marker. */
export const DIAGNOSTIC_SOURCE = "airdress";

/** One marker and the file it belongs in. */
export interface PlacedDiagnostic {
  readonly uri: vscode.Uri;
  readonly diagnostic: vscode.Diagnostic;
}

/**
 * The range for a 1-based line and column. A column marks from there to
 * the end of the line, no column marks the whole line; the editor clamps
 * the end to the line's real length.
 */
export function rangeFor(line?: number, column?: number): vscode.Range {
  const l = line && line > 0 ? line - 1 : 0;
  const c = column && column > 0 ? column - 1 : 0;
  return new vscode.Range(l, c, l, Number.MAX_SAFE_INTEGER);
}

/** The archive path as a URI inside the checkout, if it is safe to join. */
function fileIn(root: vscode.Uri, archivePath: string): vscode.Uri | undefined {
  const parts = archivePath.split("/");
  if (
    archivePath.startsWith("/") ||
    parts.some((p) => p === ".." || p === "." || p === "")
  ) {
    return undefined;
  }
  return vscode.Uri.joinPath(root, ...parts);
}

/**
 * Markers for a refusal, grouped by nothing: one per location, each
 * pointing at the others, plus one per capability not granted on
 * `function.json` — the file that asked for it.
 */
export function refusalDiagnostics(
  root: vscode.Uri,
  refusal: SourceRefusal,
): PlacedDiagnostic[] {
  const out: PlacedDiagnostic[] = [];
  const placed = refusal.locations
    .map((loc) => ({ loc, uri: fileIn(root, loc.path) }))
    .filter(
      (p): p is { loc: (typeof refusal.locations)[number]; uri: vscode.Uri } =>
        p.uri !== undefined,
    );
  for (const { loc, uri } of placed) {
    const d = new vscode.Diagnostic(
      rangeFor(loc.line, loc.column),
      refusal.message,
      vscode.DiagnosticSeverity.Error,
    );
    d.source = DIAGNOSTIC_SOURCE;
    d.code = refusal.error;
    const others = placed.filter((p) => p.loc !== loc);
    if (others.length > 0) {
      d.relatedInformation = others.map(
        (o) =>
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(o.uri, rangeFor(o.loc.line, o.loc.column)),
            `also: ${o.loc.path}${o.loc.line ? `:${o.loc.line}` : ""}`,
          ),
      );
    }
    out.push({ uri, diagnostic: d });
  }
  for (const denial of refusal.denials) {
    const d = new vscode.Diagnostic(
      rangeFor(),
      `${denial.capability} is not granted: ${denial.detail}. The grant is ` +
        `${denial.grantPath} in the Function manifest; change it by applying ` +
        "the manifest — a publish can never widen it.",
      vscode.DiagnosticSeverity.Error,
    );
    d.source = DIAGNOSTIC_SOURCE;
    d.code = refusal.error;
    out.push({ uri: vscode.Uri.joinPath(root, MANIFEST_FILE), diagnostic: d });
  }
  return out;
}

/**
 * Replace a checkout's markers with these. Markers for files elsewhere
 * are left alone; every file in this checkout that had one and has none
 * now is cleared.
 */
export function applyDiagnostics(
  collection: vscode.DiagnosticCollection,
  root: vscode.Uri,
  placed: readonly PlacedDiagnostic[],
): void {
  const base = root.path.endsWith("/") ? root.path : `${root.path}/`;
  const stale: vscode.Uri[] = [];
  collection.forEach((uri) => {
    if (uri.path.startsWith(base)) {
      stale.push(uri);
    }
  });
  for (const uri of stale) {
    collection.delete(uri);
  }
  const byFile = new Map<
    string,
    { uri: vscode.Uri; ds: vscode.Diagnostic[] }
  >();
  for (const p of placed) {
    const key = p.uri.toString();
    const entry = byFile.get(key) ?? { uri: p.uri, ds: [] };
    entry.ds.push(p.diagnostic);
    byFile.set(key, entry);
  }
  for (const { uri, ds } of byFile.values()) {
    collection.set(uri, ds);
  }
}
