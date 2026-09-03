import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import * as YAML from "yaml";

/**
 * Manifest validation (SPEC-057 T6-04/T6-05).
 *
 * Ajv is BUNDLED: validation works with no other extension installed
 * (FR-29). The `yamlValidation`/`jsonValidation` contributions in
 * package.json add editor-native squiggles when redhat.vscode-yaml is
 * present, but nothing here depends on it.
 *
 * Honesty rule (NFR-10): a kind with no bundled schema is reported as
 * UNKNOWN with validation disabled — never as valid. A green checkmark
 * that means "I did not check" is worse than no checkmark.
 */

/** Parsed manifest envelope — the operator's Manifest shape. */
export interface ManifestEnvelope {
  apiVersion: string;
  kind: string;
  metadata: { name: string; [k: string]: unknown };
  spec: unknown;
}

export interface ValidationIssue {
  /** JSON-pointer-ish path into the document ("" = root). */
  path: string;
  message: string;
}

export type ValidationStatus =
  "valid" | "invalid" | "unknown-kind" | "parse-error";

export interface ValidationResult {
  status: ValidationStatus;
  kind?: string;
  issues: ValidationIssue[];
}

/** A bundled per-kind schema with its operator-version pin (FR-33). */
export interface KindSchema {
  kind: string;
  schema: object & { "x-airdress-operator-version"?: string };
}

function ajvIssues(
  errors: ErrorObject[] | null | undefined,
): ValidationIssue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || "/",
    message: e.message ?? "invalid",
  }));
}

/**
 * Parse manifest text (YAML or JSON — YAML.parse handles both) into the
 * envelope, without validating the spec.
 */
export function parseManifest(
  text: string,
): { envelope: ManifestEnvelope } | { error: string } {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { error: "Manifest must be a mapping/object." };
  }
  const m = doc as Record<string, unknown>;
  if (typeof m.kind !== "string" || m.kind.length === 0) {
    return { error: "Manifest is missing a `kind`." };
  }
  if (typeof m.apiVersion !== "string" || m.apiVersion.length === 0) {
    return { error: "Manifest is missing an `apiVersion`." };
  }
  const metadata = m.metadata as Record<string, unknown> | undefined;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    typeof metadata.name !== "string" ||
    metadata.name.length === 0
  ) {
    return { error: "Manifest is missing `metadata.name`." };
  }
  return {
    envelope: {
      apiVersion: m.apiVersion,
      kind: m.kind,
      metadata: metadata as ManifestEnvelope["metadata"],
      spec: m.spec,
    },
  };
}

/** Registry of bundled per-kind schemas, compiled once. */
export class SchemaRegistry {
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly pins = new Map<string, string | undefined>();

  constructor(schemas: KindSchema[]) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const { kind, schema } of schemas) {
      this.validators.set(kind, ajv.compile(schema));
      this.pins.set(kind, schema["x-airdress-operator-version"]);
    }
  }

  kinds(): string[] {
    return [...this.validators.keys()];
  }

  /** The operator version the kind's schema was authored against. */
  versionPin(kind: string): string | undefined {
    return this.pins.get(kind);
  }

  /** Validate manifest TEXT (YAML or JSON). */
  validateText(text: string): ValidationResult {
    const parsed = parseManifest(text);
    if ("error" in parsed) {
      return {
        status: "parse-error",
        issues: [{ path: "/", message: parsed.error }],
      };
    }
    return this.validateEnvelope(parsed.envelope);
  }

  /** Validate a parsed envelope's spec against its kind's schema. */
  validateEnvelope(envelope: ManifestEnvelope): ValidationResult {
    const validator = this.validators.get(envelope.kind);
    if (!validator) {
      // NEVER silently valid: the honest degradation for a kind we do
      // not know is "unknown, validation disabled" (NFR-10).
      return {
        status: "unknown-kind",
        kind: envelope.kind,
        issues: [
          {
            path: "/kind",
            message:
              `Kind "${envelope.kind}" is unknown to this extension — ` +
              "validation is disabled for it (not a statement of validity).",
          },
        ],
      };
    }
    const ok = validator(envelope);
    return {
      status: ok ? "valid" : "invalid",
      kind: envelope.kind,
      issues: ok ? [] : ajvIssues(validator.errors),
    };
  }
}
