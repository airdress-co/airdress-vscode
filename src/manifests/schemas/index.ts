import type { KindSchema } from "../validate";
import inferencePoolMember from "./inference-pool-member.json";

/**
 * Bundled per-kind JSON Schemas (SPEC-057 T6-05).
 *
 * Each schema carries an `x-airdress-operator-version` pin naming the
 * operator version it was authored from (FR-33) — "which operator does
 * this schema describe?" is answerable without archaeology. A kind not
 * listed here is reported as unknown with validation disabled — never
 * as valid (NFR-10).
 *
 * The operator registers exactly one kind in v1 (serve.rs registers
 * InferencePoolMember); the real fix — GET /v1/kinds/{kind}/schema on
 * the operator — is a SPEC-036 contract change tracked upstream
 * (tasks.md §12.5 decision), at which point this file shrinks to a
 * fallback set.
 *
 * NOTE: `schemas/inference-pool-member.schema.json` (shipped for the
 * yamlValidation/jsonValidation editor associations) must stay
 * byte-identical to `./inference-pool-member.json` — a test enforces
 * it.
 */
export function bundledSchemas(): KindSchema[] {
  return [
    {
      kind: "InferencePoolMember",
      schema: inferencePoolMember as KindSchema["schema"],
    },
  ];
}
