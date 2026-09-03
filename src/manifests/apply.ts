import * as vscode from "vscode";
import { ApiError } from "../api/client";
import type { Profile } from "../profiles/model";
import { resolveProfile } from "../profiles/picker";
import { bundledSchemas } from "./schemas";
import { parseManifest, SchemaRegistry } from "./validate";
import { clientFor, type ManifestDeps } from "./diff";

/**
 * Explicit apply (design §5.1/§5.2).
 *
 * Apply is a COMMAND, invoked deliberately, always. There is no code
 * path from a save event to an apply anywhere in this extension —
 * autosave, formatters, and other extensions all trigger saves, and a
 * mutation of live configuration must never ride on an event the user
 * does not control. A test asserts the shipped bundle registers no
 * save listener.
 *
 * The confirmation names the target PROFILE and FQDN because the
 * realistic accident is not "I did not mean to apply" — it is "I did
 * not mean to apply THERE" (FR-28).
 */

let registry: SchemaRegistry | undefined;
function schemaRegistry(): SchemaRegistry {
  registry ??= new SchemaRegistry(bundledSchemas());
  return registry;
}

const diagnostics = vscode.languages.createDiagnosticCollection("airdress");

/** Surface an RFC 7807 Problem verbatim as a diagnostic on the manifest. */
export function problemToDiagnostic(err: ApiError): vscode.Diagnostic {
  const parts = [
    err.problem.title ?? `HTTP ${err.httpStatus}`,
    err.problem.detail,
  ].filter(Boolean);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 1),
    parts.join(" — "),
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = "airdress-operator";
  diagnostic.code = err.problem.type;
  return diagnostic;
}

/** Ajv results as diagnostics (bundled validator — FR-29). */
export function validateDocument(doc: vscode.TextDocument): void {
  const result = schemaRegistry().validateText(doc.getText());
  if (result.status === "valid") {
    diagnostics.set(doc.uri, []);
    void vscode.window.setStatusBarMessage(
      `Airdress: ${result.kind} manifest is valid.`,
      5_000,
    );
    return;
  }
  const severity =
    result.status === "unknown-kind"
      ? vscode.DiagnosticSeverity.Information
      : vscode.DiagnosticSeverity.Error;
  diagnostics.set(
    doc.uri,
    result.issues.map((issue) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        issue.path === "/" ? issue.message : `${issue.path}: ${issue.message}`,
        severity,
      );
      d.source = "airdress";
      return d;
    }),
  );
}

/** "Airdress: Validate Manifest" command. */
export async function validateCommand(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    return;
  }
  validateDocument(doc);
}

/**
 * "Airdress: Apply Manifest" — POST /v1/apply after a modal confirm
 * that names the profile and FQDN.
 */
export async function applyManifest(
  deps: ManifestDeps,
  explicitProfile?: Profile,
): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !["yaml", "json"].includes(doc.languageId)) {
    void vscode.window.showWarningMessage(
      "Airdress: open a YAML or JSON manifest first. " +
        "(Fleet TOML manifests are applied by pyinfra, never by this extension.)",
    );
    return;
  }
  const text = doc.getText();
  const parsed = parseManifest(text);
  if ("error" in parsed) {
    void vscode.window.showErrorMessage(
      `Airdress: cannot apply — ${parsed.error}`,
    );
    return;
  }
  const { kind, metadata } = parsed.envelope;

  // Pre-apply validation: hard-invalid blocks; unknown kind proceeds
  // with honesty (the operator is the authority) after the confirm.
  const result = schemaRegistry().validateText(text);
  if (result.status === "invalid" || result.status === "parse-error") {
    validateDocument(doc);
    void vscode.window.showErrorMessage(
      "Airdress: the manifest fails schema validation — fix the diagnostics first.",
    );
    return;
  }

  const profile = await resolveProfile(deps.profiles, explicitProfile);
  if (!profile) {
    return;
  }

  // FR-28: name the target. The realistic accident is the wrong operator.
  const confirm = await vscode.window.showWarningMessage(
    `Apply ${kind}/${metadata.name} to profile "${profile.label}" (${profile.fqdn})?`,
    { modal: true },
    "Apply",
  );
  if (confirm !== "Apply") {
    return;
  }

  try {
    const response = await clientFor(deps, profile).send("/v1/apply", {
      method: "POST",
      headers: {
        "content-type":
          doc.languageId === "json" ? "application/json" : "application/yaml",
      },
      body: text,
    });
    diagnostics.set(doc.uri, []);
    void vscode.window.showInformationMessage(
      response.status === 202
        ? `Airdress: ${kind}/${metadata.name} accepted by ${profile.fqdn} (reconciling).`
        : `Airdress: ${kind}/${metadata.name} applied to ${profile.fqdn}.`,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      // The operator's own title/detail, verbatim (design §5.1 step 7).
      diagnostics.set(doc.uri, [problemToDiagnostic(err)]);
      void vscode.window.showErrorMessage(
        `Airdress: apply to ${profile.fqdn} failed — see the diagnostic on the manifest.`,
      );
    } else {
      void vscode.window.showErrorMessage(
        `Airdress: apply to ${profile.fqdn} failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
