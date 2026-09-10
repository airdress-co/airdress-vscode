import type { KindSchema } from "../validate";
import functionKind from "./function.json";
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
 * NOTE: every `schemas/<kind>.schema.json` (shipped for the
 * yamlValidation/jsonValidation editor associations) must stay
 * byte-identical to its `./<kind>.json` twin — a test enforces it, and
 * the sync script writes both from the same bytes.
 *
 * `./function.json` is the one exception to "never edit by hand", for
 * now: the operator has not published `Function` yet, so it was seeded
 * from the operator's contract. The sync script only rewrites kinds the
 * index lists, so the seed survives a sync until the operator's next
 * release publishes the kind — at which point `npm run sync:schemas`
 * replaces the bytes and the exception ends.
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
  ];
}
