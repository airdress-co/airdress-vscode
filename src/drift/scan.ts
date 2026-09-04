import type { MappingEntry } from "./mapping";

/**
 * Workspace drift classification — REPORT, NEVER REMEDIATE.
 *
 * Four classes, and every input produces exactly one row — nothing is
 * silently dropped, because silence from a drift scanner reads as "no
 * drift" and that is a lie:
 *
 *   in-sync    mapped file matches the live resource
 *   drifted    mapped file differs from the live resource (or cannot
 *              be compared — an unreadable file is not "fine")
 *   missing    mapped file, but no live resource behind it
 *   unmanaged  live resource with no mapped file
 *
 * No code path in this module (or anywhere reachable from the scan
 * command) issues a write: an auto-remediating drift scan eventually
 * reverts somebody's deliberate 3 a.m. change. Rows offer a diff; the
 * apply path stays the ordinary apply command with its confirm.
 */

export type DriftClass = "in-sync" | "drifted" | "missing" | "unmanaged";

export interface DriftRow {
  classification: DriftClass;
  kind: string;
  name: string;
  /** Workspace-relative path — absent for unmanaged rows. */
  path?: string;
  /** Human explanation when the classification needs one. */
  detail?: string;
}

/** One mapped entry with what the scan could gather about it. */
export interface MappedObservation {
  entry: MappingEntry;
  /** Parsed local manifest document; undefined when unreadable. */
  localDoc?: unknown;
  /** Why the local file could not be read/parsed, when it could not. */
  localError?: string;
  /** The live resource document; undefined = no live resource (404). */
  liveDoc?: unknown;
}

/**
 * Deep subset match: everything the DECLARED document states must hold
 * in the live document; live-only fields (status, timestamps, server
 * defaults the manifest never mentioned) do not count as drift.
 */
export function isDeclaredSubsetOfLive(
  declared: unknown,
  live: unknown,
): boolean {
  if (
    typeof declared === "object" &&
    declared !== null &&
    !Array.isArray(declared)
  ) {
    if (typeof live !== "object" || live === null || Array.isArray(live)) {
      return false;
    }
    return Object.entries(declared as Record<string, unknown>).every(
      ([key, value]) =>
        isDeclaredSubsetOfLive(value, (live as Record<string, unknown>)[key]),
    );
  }
  if (Array.isArray(declared)) {
    if (!Array.isArray(live) || live.length !== declared.length) {
      return false;
    }
    return declared.every((item, i) => isDeclaredSubsetOfLive(item, live[i]));
  }
  return declared === live;
}

/**
 * Classify every mapped entry AND every unmapped live resource.
 * Total: rows.length === observations.length + (unmanaged live count).
 */
export function classifyDrift(
  observations: MappedObservation[],
  liveInventory: Array<{ kind: string; name: string }>,
): DriftRow[] {
  const rows: DriftRow[] = observations.map((obs) => {
    const { entry } = obs;
    if (obs.liveDoc === undefined) {
      // A mapped file whose resource is gone IS drift — not a skip.
      return {
        classification: "missing",
        kind: entry.kind,
        name: entry.name,
        path: entry.path,
        detail: "mapped file has no live resource behind it",
      };
    }
    if (obs.localError !== undefined || obs.localDoc === undefined) {
      // Cannot compare ≠ in sync. An unreadable mapped file must not
      // scan as "no drift".
      return {
        classification: "drifted",
        kind: entry.kind,
        name: entry.name,
        path: entry.path,
        detail: `local file cannot be compared: ${obs.localError ?? "unreadable"}`,
      };
    }
    return isDeclaredSubsetOfLive(obs.localDoc, obs.liveDoc)
      ? {
          classification: "in-sync",
          kind: entry.kind,
          name: entry.name,
          path: entry.path,
        }
      : {
          classification: "drifted",
          kind: entry.kind,
          name: entry.name,
          path: entry.path,
          detail: "declared state differs from live state",
        };
  });

  const mapped = new Set(
    observations.map((o) => `${o.entry.kind}/${o.entry.name}`),
  );
  for (const resource of liveInventory) {
    if (!mapped.has(`${resource.kind}/${resource.name}`)) {
      // A live resource nobody's file declares IS drift — not a skip.
      rows.push({
        classification: "unmanaged",
        kind: resource.kind,
        name: resource.name,
        detail: "live resource with no mapped manifest file",
      });
    }
  }
  return rows;
}
