import type { KindSchema } from "../validate";
import inferencePoolMember from "./inference-pool-member.json";

/**
 * Bundled per-kind JSON Schemas.
 *
 * The `.json` files here are GENERATED artifacts — byte-for-byte copies
 * of the version-pinned schemas the operator publishes at
 * https://schemas.airdress.co/operator/index.json. Never edit them by
 * hand; refresh with `npm run sync:schemas` (scripts/sync-schemas.mjs),
 * which pulls the pinned URLs so a run is reproducible. CI's sync-check
 * job fails on drift from the published pinned artifacts.
 *
 * Each schema carries an `x-airdress-operator-version` pin naming the
 * operator version it was generated from — "which operator does this
 * schema describe?" is answerable without archaeology. A kind not
 * listed here is reported as unknown with validation disabled — never
 * as valid.
 *
 * NOTE: `schemas/inference-pool-member.schema.json` (shipped for the
 * yamlValidation/jsonValidation editor associations) must stay
 * byte-identical to `./inference-pool-member.json` — a test enforces
 * it, and the sync script writes both from the same bytes.
 */
export function bundledSchemas(): KindSchema[] {
  return [
    {
      kind: "InferencePoolMember",
      schema: inferencePoolMember as KindSchema["schema"],
    },
  ];
}
