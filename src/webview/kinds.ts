/**
 * Per-Kind extras for the resource panel (design §2.1).
 *
 * The panel itself is Kind-agnostic: it renders a form from the Kind's
 * published JSON Schema, or a raw-YAML editor when there is no schema to
 * render, and applies through the one `/v1/apply` path either way. This
 * table only records the handful of Kinds that additionally carry
 * affordances nothing else has — today that is `Function`, which can be
 * invoked at `POST /fn/<name>` and names a bundle on the operator's disk.
 *
 * Deliberately a lookup rather than a plugin system. Three Kinds exist,
 * and a closed table a person can read beats an abstraction nobody needs
 * yet — the same reasoning the operator's ManagedUnit applied to its closed control enum.
 * A Kind absent from this table is not unsupported; it is the ordinary
 * case and gets the generic panel.
 */

/** Extras a Kind may declare beyond plain CRUD. */
export type KindExtras = "function";

export interface KindCapabilities {
  /**
   * Extra affordances rendered below the form. `undefined` — the common
   * case — means plain create/read/update/delete.
   */
  readonly extras?: KindExtras;
  /** `apiVersion` stamped into a manifest this panel creates. */
  readonly apiVersion: string;
}

/**
 * Every Kind the operator has published a schema for so far sits on
 * `airdress.co/v1alpha1`. A Kind that later moves group or version gets
 * an entry here rather than a special case at the call site.
 */
const DEFAULT_API_VERSION = "airdress.co/v1alpha1";

const CAPABILITIES: Readonly<Record<string, KindCapabilities>> = {
  Function: { extras: "function", apiVersion: DEFAULT_API_VERSION },
};

export function capabilitiesFor(kind: string): KindCapabilities {
  return CAPABILITIES[kind] ?? { apiVersion: DEFAULT_API_VERSION };
}

/** Whether this Kind carries the Function-only invoke/bundle affordances. */
export function hasFunctionExtras(kind: string): boolean {
  return capabilitiesFor(kind).extras === "function";
}
