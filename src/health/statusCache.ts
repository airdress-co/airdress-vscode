import type { CorrectnessSignal } from "./state";

/**
 * Per-resource status cache, filled by the Resources view as it
 * expands. The health roll-up READS this cache instead of issuing a
 * parallel status sweep — one set of status calls serves both surfaces.
 *
 * An empty cache is honest: correctness is "unavailable" with a reason
 * naming the missing signal, never a silent all-clear.
 */

export interface CachedStatus {
  kind: string;
  name: string;
  ready: boolean;
  /** The operator's own status word, verbatim. */
  state: string;
  checkedAt: string;
}

export class StatusCache {
  /** profileId → "kind/name" → status */
  private readonly byProfile = new Map<string, Map<string, CachedStatus>>();

  set(profileId: string, status: CachedStatus): void {
    let map = this.byProfile.get(profileId);
    if (!map) {
      map = new Map();
      this.byProfile.set(profileId, map);
    }
    map.set(`${status.kind}/${status.name}`, status);
  }

  get(profileId: string, kind: string, name: string): CachedStatus | undefined {
    return this.byProfile.get(profileId)?.get(`${kind}/${name}`);
  }

  clear(profileId?: string): void {
    if (profileId) {
      this.byProfile.delete(profileId);
    } else {
      this.byProfile.clear();
    }
  }

  /** Roll the cached statuses up into the correctness signal. */
  correctnessFor(profileId: string): CorrectnessSignal {
    const map = this.byProfile.get(profileId);
    if (!map || map.size === 0) {
      return {
        signal: "unavailable",
        reason: "no resource statuses observed yet — expand Resources",
      };
    }
    const all = [...map.values()];
    const notReady = all.filter((s) => !s.ready);
    const checkedAt = all
      .map((s) => s.checkedAt)
      .sort()
      .at(-1) as string;
    if (notReady.length === 0) {
      return { signal: "all-ready", total: all.length, checkedAt };
    }
    return {
      signal: "not-ready",
      total: all.length,
      notReady: notReady.map((s) => ({
        kind: s.kind,
        name: s.name,
        state: s.state,
      })),
      checkedAt,
    };
  }
}
