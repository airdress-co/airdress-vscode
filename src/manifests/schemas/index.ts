import type { KindSchema } from "../validate";
import functionKind from "./function.json";
import inferencePoolMember from "./inference-pool-member.json";
import schedule from "./schedule.json";

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
 * NOTE: every `schemas/<kind>.schema.json` (shipped for the
 * yamlValidation/jsonValidation editor associations) must stay
 * byte-identical to its `./<kind>.json` twin — a test enforces it, and
 * the sync script writes both from the same bytes.
 *
 * Adding a Kind is two lines here (the import and the entry) once the
 * operator publishes its schema, plus one `if`/`then` arm in
 * `schemas/operator-manifest.schema.json` so the editor association
 * dispatches to it. Nothing else in the extension names the Kind: the
 * resource panel draws its form from whatever schema this
 * list returns, and a Kind missing here still gets the panel in
 * raw-YAML mode.
 */
export function bundledSchemas(): KindSchema[] {
  return [
    {
      kind: "Function",
      schema: functionKind as KindSchema["schema"],
    },
    {
      kind: "InferencePoolMember",
      schema: inferencePoolMember as KindSchema["schema"],
    },
    {
      kind: "Schedule",
      schema: schedule as KindSchema["schema"],
    },
  ];
}
