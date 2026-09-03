/**
 * Manifest validation diagnostics.
 *
 * TODO(SPEC-057 T6-07): Ajv-backed validation against the schemas in
 * src/manifests/schemas/ (pinned to OPERATOR_VERSION), surfacing results
 * as vscode.Diagnostic entries. Note that yamlValidation/jsonValidation
 * in package.json already cover editor-native squiggles; this module is
 * for on-demand and pre-apply validation.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateManifest(_document: unknown): ValidationIssue[] {
  throw new Error("TODO(SPEC-057 T6-07): manifest validation not implemented");
}
