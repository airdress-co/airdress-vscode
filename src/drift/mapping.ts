/**
 * The explicit manifest → resource mapping: `.airdress/manifests.json`
 * in the workspace — committed, reviewable, editable BY HAND.
 *
 * Nothing is ever inferred from filenames. A mapping the user cannot
 * see is one they cannot correct, and its failure mode is a drift scan
 * reporting "no drift" for a file it never matched — the worst
 * possible output from a tool whose whole job is reporting
 * differences.
 *
 * A committed workspace file (rather than extension-internal state)
 * was a deliberate choice: the workspace already contains the manifest
 * files themselves, so the mapping travels, diffs and reviews with
 * them. Teams whose manifests live in a public repository while their
 * operator hostname does not should keep the mapping out of that
 * repository — it lists the profile hostname.
 */

export const MAPPING_PATH = ".airdress/manifests.json";

export interface MappingEntry {
  /** Workspace-relative path of the manifest file. */
  path: string;
  kind: string;
  name: string;
}

export interface ManifestMapping {
  /** The operator profile (its FQDN) this workspace maps onto. */
  profile: string;
  manifests: MappingEntry[];
}

/** Parse mapping text, reporting WHAT is wrong rather than guessing. */
export function parseMapping(
  text: string,
): { mapping: ManifestMapping } | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      error: `${MAPPING_PATH} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { error: `${MAPPING_PATH} must be a JSON object.` };
  }
  const m = doc as Record<string, unknown>;
  if (typeof m.profile !== "string" || m.profile.length === 0) {
    return {
      error: `${MAPPING_PATH} needs a "profile" (the operator FQDN).`,
    };
  }
  if (!Array.isArray(m.manifests)) {
    return { error: `${MAPPING_PATH} needs a "manifests" array.` };
  }
  const manifests: MappingEntry[] = [];
  for (const [index, raw] of m.manifests.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return { error: `manifests[${index}] must be an object.` };
    }
    const entry = raw as Record<string, unknown>;
    for (const field of ["path", "kind", "name"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        return {
          error: `manifests[${index}] is missing "${field}" — every entry needs path, kind and name.`,
        };
      }
    }
    manifests.push({
      path: entry.path as string,
      kind: entry.kind as string,
      name: entry.name as string,
    });
  }
  return { mapping: { profile: m.profile, manifests } };
}

/** Serialize with stable formatting so hand-edits diff cleanly. */
export function serializeMapping(mapping: ManifestMapping): string {
  return JSON.stringify(mapping, null, 2) + "\n";
}

/**
 * Add (or update) entries. An entry is keyed by (kind, name): re-adding
 * a resource re-points it at the new path; re-adding the same file
 * refreshes its resources. Order is preserved for stable diffs.
 */
export function addEntries(
  mapping: ManifestMapping,
  entries: MappingEntry[],
): ManifestMapping {
  const merged = [...mapping.manifests];
  for (const entry of entries) {
    const existing = merged.findIndex(
      (e) => e.kind === entry.kind && e.name === entry.name,
    );
    if (existing >= 0) {
      merged[existing] = entry;
    } else {
      merged.push(entry);
    }
  }
  return { ...mapping, manifests: merged };
}
