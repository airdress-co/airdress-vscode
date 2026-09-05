import * as vscode from "vscode";
import { ApiError } from "../api/client";
import type { Profile } from "../profiles/model";
import { resolveProfile } from "../profiles/picker";
import { bundledSchemas } from "./schemas";
import { validateFleetText } from "./fleet";
import { SchemaRegistry, type ValidationResult } from "./validate";
import { clientFor, type ManifestDeps } from "./diff";
import {
  applyConfirmation,
  planApplyDocuments,
  type PlannedDoc,
} from "./scope";

/**
 * Explicit apply.
 *
 * Apply is a COMMAND, invoked deliberately, always. There is no code
 * path from a save event to an apply anywhere in this extension —
 * autosave, formatters, and other extensions all trigger saves, and a
 * mutation of live configuration must never ride on an event the user
 * does not control. A test asserts the shipped bundle registers no
 * save listener.
 *
 * Validate is a DIFFERENT command with different consequences: it runs
 * the bundled schema validation and reports diagnostics, and has no
 * code path that could issue a mutating request — "is this
 * well-formed?" and "make this real" are different questions.
 *
 * The apply confirmation names the target PROFILE and FQDN because the
 * realistic accident is not "I did not mean to apply" — it is "I did
 * not mean to apply THERE".
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

/**
 * Anchor a rejection `path` (e.g. `apiVersion`, `spec.backend`) to the
 * matching key in the document. The search starts at `offset` so the
 * anchor lands in the failing document of a multi-document file, and
 * matches both YAML (`key:`) and JSON (`"key":`) spellings of the
 * path's last segment. When the key cannot be found, fall back to the
 * top of the file — a wrong-but-present diagnostic beats none.
 */
export function pathAnchorRange(
  doc: vscode.TextDocument,
  path: string,
  offset: number,
): vscode.Range {
  const key = path
    .split(/[./]/)
    .filter((s) => s.length > 0)
    .pop();
  if (key && /^[\w-]+$/.test(key)) {
    const re = new RegExp(`(?:^|\\n)[ \\t-]*"?(${key})"?\\s*:`, "g");
    re.lastIndex = Math.max(0, offset - 1);
    const m = re.exec(doc.getText());
    if (m) {
      const keyStart = m.index + m[0].lastIndexOf(m[1]);
      return new vscode.Range(
        doc.positionAt(keyStart),
        doc.positionAt(keyStart + m[1].length),
      );
    }
  }
  return new vscode.Range(0, 0, 0, 1);
}

/**
 * Map an apply failure onto the manifest as a diagnostic. Handles both
 * error shapes the operator actually emits — RFC 7807 Problems
 * (`title`/`detail`) and the manifest-rejection shape (`{error, path}`,
 * e.g. HTTP 400 for an unsupported apiVersion) — showing the
 * operator's own message verbatim either way. For the `{error, path}`
 * shape the diagnostic is anchored to the offending key when findable.
 */
export function applyErrorDiagnostic(
  err: ApiError,
  doc: vscode.TextDocument,
  offset: number,
): vscode.Diagnostic {
  if (err.problem.error === undefined) {
    return problemToDiagnostic(err);
  }
  const range = err.problem.path
    ? pathAnchorRange(doc, err.problem.path, offset)
    : new vscode.Range(0, 0, 0, 1);
  const diagnostic = new vscode.Diagnostic(
    range,
    err.problem.error,
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = "airdress-operator";
  diagnostic.code = err.problem.path;
  return diagnostic;
}

function resultDiagnostics(
  doc: vscode.TextDocument,
  result: ValidationResult,
  offset: number,
): vscode.Diagnostic[] {
  const severity =
    result.status === "unknown-kind"
      ? vscode.DiagnosticSeverity.Information
      : vscode.DiagnosticSeverity.Error;
  const position = doc.positionAt(offset);
  const range = new vscode.Range(position, position.translate(0, 1));
  return result.issues.map((issue) => {
    const d = new vscode.Diagnostic(
      range,
      issue.path === "/" ? issue.message : `${issue.path}: ${issue.message}`,
      severity,
    );
    d.source = "airdress";
    return d;
  });
}

/**
 * Validate a manifest document and publish diagnostics. Purely local:
 * the bundled Ajv registry, no network, no writes. Multi-document YAML
 * files are validated per document.
 */
export function validateDocument(doc: vscode.TextDocument): void {
  // Fleet TOML is validate-only: there is no endpoint to
  // apply it to, and no apply affordance exists for it.
  if (doc.languageId === "toml") {
    const result = validateFleetText(doc.getText());
    if (result.status === "valid") {
      diagnostics.set(doc.uri, []);
      void vscode.window.setStatusBarMessage(
        `Airdress: ${result.kind} manifest is valid.`,
        5_000,
      );
      return;
    }
    diagnostics.set(doc.uri, resultDiagnostics(doc, result, 0));
    return;
  }

  const plan = planApplyDocuments(doc.getText(), doc.languageId);
  if ("error" in plan) {
    diagnostics.set(doc.uri, [
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        plan.error,
        vscode.DiagnosticSeverity.Error,
      ),
    ]);
    return;
  }
  const all: vscode.Diagnostic[] = [];
  const kinds: string[] = [];
  for (const planned of plan.docs) {
    const result = schemaRegistry().validateText(planned.text);
    if (result.status === "valid") {
      kinds.push(planned.kind);
      continue;
    }
    all.push(...resultDiagnostics(doc, result, planned.offset));
  }
  diagnostics.set(doc.uri, all);
  if (all.length === 0) {
    void vscode.window.setStatusBarMessage(
      plan.docs.length === 1
        ? `Airdress: ${kinds[0]} manifest is valid.`
        : `Airdress: all ${plan.docs.length} manifest documents are valid.`,
      5_000,
    );
  }
}

/**
 * "Airdress: Validate Manifest" — diagnostics only. This function (and
 * everything it calls) takes no API client and holds no credential: a
 * mutating request is structurally impossible from this command, which
 * is the point of having it exist separately from apply.
 */
export async function validateCommand(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    return;
  }
  validateDocument(doc);
}

/** Pick the subset of documents to apply (multi-document files only). */
async function pickApplyScope(
  docs: PlannedDoc[],
): Promise<PlannedDoc[] | undefined> {
  if (docs.length === 1) {
    return docs;
  }
  // Apply-all stays the one-click default; selecting a subset is an
  // extra option, not an extra required step.
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: `Apply all ${docs.length} resources`,
        description: docs.map((d) => `${d.kind}/${d.name}`).join(", "),
        all: true,
      },
      {
        label: "Select resources to apply…",
        description: "apply a subset of this file",
        all: false,
      },
    ],
    { placeHolder: "This file declares several resources" },
  );
  if (!mode) {
    return undefined;
  }
  if (mode.all) {
    return docs;
  }
  const picked = await vscode.window.showQuickPick(
    docs.map((d) => ({
      label: `${d.kind}/${d.name}`,
      picked: false,
      doc: d,
    })),
    {
      canPickMany: true,
      placeHolder: "Select the resources to apply",
    },
  );
  if (!picked || picked.length === 0) {
    return undefined;
  }
  return picked.map((p) => p.doc);
}

/**
 * "Airdress: Apply Manifest" — POST /v1/apply after a modal confirm
 * that names the selected resources and the profile + FQDN. Files
 * declaring several resources support applying a selected subset.
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
  const plan = planApplyDocuments(doc.getText(), doc.languageId);
  if ("error" in plan) {
    void vscode.window.showErrorMessage(
      `Airdress: cannot apply — ${plan.error}`,
    );
    return;
  }

  // Pre-apply validation: hard-invalid blocks; unknown kind proceeds
  // with honesty (the operator is the authority) after the confirm.
  for (const planned of plan.docs) {
    const result = schemaRegistry().validateText(planned.text);
    if (result.status === "invalid" || result.status === "parse-error") {
      validateDocument(doc);
      void vscode.window.showErrorMessage(
        "Airdress: the manifest fails schema validation — fix the diagnostics first.",
      );
      return;
    }
  }

  const selected = await pickApplyScope(plan.docs);
  if (!selected) {
    return;
  }

  const profile = await resolveProfile(deps.profiles, explicitProfile);
  if (!profile) {
    return;
  }

  const confirmation = applyConfirmation(selected, profile);
  const confirm = await vscode.window.showWarningMessage(
    confirmation.message,
    { modal: true, detail: confirmation.detail },
    "Apply",
  );
  if (confirm !== "Apply") {
    return;
  }

  const applied: string[] = [];
  let accepted = false;
  for (const planned of selected) {
    try {
      const response = await clientFor(deps, profile).send("/v1/apply", {
        method: "POST",
        headers: {
          "content-type":
            doc.languageId === "json" ? "application/json" : "application/yaml",
        },
        body: planned.text,
      });
      accepted ||= response.status === 202;
      applied.push(`${planned.kind}/${planned.name}`);
    } catch (err) {
      const done = applied.length
        ? ` Applied before the failure: ${applied.join(", ")}.`
        : "";
      if (err instanceof ApiError) {
        // The operator's own message, verbatim — whichever shape it used.
        diagnostics.set(doc.uri, [
          applyErrorDiagnostic(err, doc, planned.offset),
        ]);
        void vscode.window.showErrorMessage(
          `Airdress: applying ${planned.kind}/${planned.name} to ${profile.fqdn} failed — see the diagnostic on the manifest.${done}`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `Airdress: applying ${planned.kind}/${planned.name} to ${profile.fqdn} failed — ${
            err instanceof Error ? err.message : String(err)
          }${done}`,
        );
      }
      return;
    }
  }
  diagnostics.set(doc.uri, []);
  const what =
    applied.length === 1 ? applied[0] : `${applied.length} resources`;
  void vscode.window.showInformationMessage(
    accepted
      ? `Airdress: ${what} accepted by ${profile.fqdn} (reconciling).`
      : `Airdress: ${what} applied to ${profile.fqdn}.`,
  );
}
