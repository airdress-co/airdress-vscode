import * as fs from "node:fs";
import * as path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseToml } from "@iarna/toml";
import type { ValidationResult } from "./validate";

/**
 * Fleet VM TOML manifests — VALIDATE-ONLY.
 *
 * These files look like manifests and are not, in the sense that
 * matters: they have no HTTP endpoint. pyinfra reads them out of the
 * ops repo and provisions Firecracker VMs. The extension validates them
 * and contributes NO apply command for them at all — not a disabled
 * one, not one that errors. An apply button that exists and refuses is
 * an invitation to look for the trick that makes it work.
 */

/**
 * The schema ships at <extensionRoot>/schemas/fleet-manifest.schema.json.
 * Two candidates cover both the bundled layout (dist/extension.js →
 * ../schemas) and the tsc test layout (out/manifests/ → ../../schemas).
 */
function loadFleetSchema(): object {
  const candidates = [
    path.join(__dirname, "..", "schemas", "fleet-manifest.schema.json"),
    path.join(__dirname, "..", "..", "schemas", "fleet-manifest.schema.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as object;
    }
  }
  throw new Error("fleet-manifest.schema.json not found in the extension.");
}

let validator: ValidateFunction | undefined;
function fleetValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    validator = ajv.compile(loadFleetSchema());
  }
  return validator;
}

/** Validate fleet-manifest TOML text. Never applies anything. */
export function validateFleetText(text: string): ValidationResult {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch (err) {
    return {
      status: "parse-error",
      issues: [
        {
          path: "/",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
  const validate = fleetValidator();
  const ok = validate(doc);
  return {
    status: ok ? "valid" : "invalid",
    kind: "FleetManifest",
    issues: ok
      ? []
      : (validate.errors ?? []).map((e) => ({
          path: e.instancePath || "/",
          message: e.message ?? "invalid",
        })),
  };
}
