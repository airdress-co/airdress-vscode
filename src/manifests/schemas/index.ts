import type { KindSchema } from "../validate";

/**
 * Bundled per-kind JSON Schemas (SPEC-057 T6-05).
 *
 * Each schema carries an `x-airdress-operator-version` pin naming the
 * operator version it was read from (FR-33). A kind not listed here is
 * reported as unknown with validation disabled — never as valid.
 */
export function bundledSchemas(): KindSchema[] {
  // Populated in T6-05. Empty means every kind is honestly "unknown".
  return [];
}
