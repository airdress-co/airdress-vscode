import type { Profile } from "../profiles/model";
import type { PrincipalMeta } from "./nodes";

/**
 * Tracks whether a profile's credential is an OWNER on its operator.
 *
 * The answer gates the Principals view: for a non-owner the view is
 * ABSENT — not empty, not erroring (a node that always errors teaches
 * users to ignore errors). The probe is the sub-user list call itself,
 * mapped to "forbidden" for non-owners by the fetcher.
 *
 * Probes run only from user-gesture paths (a view becoming visible, an
 * explicit refresh) — never at activation. Results are cached per
 * profile until invalidated, so opening the sidebar repeatedly does not
 * re-interrogate the operator.
 */
export class OwnershipTracker {
  private readonly cache = new Map<string, boolean>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly probe: (
      profile: Profile,
    ) => Promise<PrincipalMeta[] | "forbidden">,
  ) {}

  /** Cached answer, if a probe already ran for this profile. */
  known(profileId: string): boolean | undefined {
    return this.cache.get(profileId);
  }

  /**
   * Whether the profile is an owner. An unreachable operator resolves
   * to false (the view stays hidden) but is NOT cached — the next
   * gesture probes again.
   */
  async isOwner(profile: Profile): Promise<boolean> {
    const cached = this.cache.get(profile.id);
    if (cached !== undefined) {
      return cached;
    }
    const running = this.inflight.get(profile.id);
    if (running) {
      return running;
    }
    const promise = (async () => {
      try {
        const result = await this.probe(profile);
        const owner = result !== "forbidden";
        this.cache.set(profile.id, owner);
        return owner;
      } catch {
        // Unreachable ≠ non-owner; hide the view now, ask again later.
        return false;
      } finally {
        this.inflight.delete(profile.id);
      }
    })();
    this.inflight.set(profile.id, promise);
    return promise;
  }

  /** Drop cached answers (one profile, or all). */
  invalidate(profileId?: string): void {
    if (profileId) {
      this.cache.delete(profileId);
    } else {
      this.cache.clear();
    }
  }
}
