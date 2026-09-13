import * as vscode from "vscode";
import { Profile } from "./model";
import { validateFqdn } from "./validate";

const STATE_KEY = "airdress.profiles";
const ACTIVE_KEY = "airdress.activeProfileId";

/**
 * Profile persistence in globalState.
 *
 * `setKeysForSync` is deliberately NOT called (design §4.5): Settings
 * Sync would replicate the list of operators a person owns to every
 * machine signed into their Microsoft/GitHub account. The tokens would
 * not travel, but the inventory would — and an inventory of operator
 * FQDNs is exactly the reconnaissance a targeted attacker wants. This
 * is a decision, not an omission; the opposite decision is defensible
 * but must be made deliberately.
 *
 * Profile records are non-secret metadata ONLY. Credentials live in
 * SecretStorage via auth/store.ts — never in globalState, never in
 * settings.json, never in workspace state (FR-21).
 *
 * The "active" profile is the STANDING TARGET: a command with nothing
 * more specific to go on acts on it without asking (picker.ts,
 * `resolveProfile`). What guards a write is not a pick but the confirm
 * in front of it, which names the target by label and FQDN — see
 * `profiles/confirm.ts`, every wording under test. This reverses the
 * original NFR-8 on purpose: "never an ambient default" was right while
 * the selection was a status-bar item nobody looked at, and wrong once
 * the selector view makes it something you always see.
 *
 * One row per airdress: `add` refuses an FQDN the store already holds,
 * and `dedupe` collapses rows an older build let through.
 */
/** `add` was asked to create a second row for an FQDN the store holds. */
export class DuplicateFqdnError extends Error {
  constructor(readonly existing: Profile) {
    super(
      `A profile for ${existing.fqdn} already exists ("${existing.label}").`,
    );
    this.name = "DuplicateFqdnError";
  }
}

export class ProfileStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires on any profile or active-selection change. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): Profile[] {
    return this.state.get<Profile[]>(STATE_KEY, []);
  }

  get(id: string): Profile | undefined {
    return this.list().find((p) => p.id === id);
  }

  /**
   * The SIGNED-IN (ZITADEL) profile that names this airdress, if any,
   * case-insensitively. Bearer profiles are excluded on purpose: a
   * sub-user's bearer for the same operator is a different principal
   * and legitimately sits beside the owner's row ("Add as profile"
   * after a sub-user is created makes exactly that).
   */
  findByFqdn(fqdn: string): Profile | undefined {
    const wanted = fqdn.toLowerCase();
    return this.list().find(
      (p) => p.authMode === "zitadel" && p.fqdn.toLowerCase() === wanted,
    );
  }

  activeId(): string | undefined {
    return this.state.get<string>(ACTIVE_KEY);
  }

  async setActive(id: string | undefined): Promise<void> {
    await this.state.update(ACTIVE_KEY, id);
    this.emitter.fire();
  }

  /**
   * Persist a profile. The FQDN is re-validated here as a last line of
   * defence — UI flows validate interactively, but nothing invalid may
   * reach the store regardless of the path in.
   */
  async add(
    profile: Profile,
    opts?: { allowLocalhost: boolean },
  ): Promise<void> {
    const error = validateFqdn(profile.fqdn, {
      allowLocalhost: opts?.allowLocalhost ?? profile.dev,
    });
    if (error) {
      throw new Error(`Invalid profile FQDN: ${error}`);
    }
    // One SIGNED-IN row per airdress; bearer rows are distinct principals.
    const existing =
      profile.authMode === "zitadel"
        ? this.findByFqdn(profile.fqdn)
        : undefined;
    if (existing && existing.id !== profile.id) {
      throw new DuplicateFqdnError(existing);
    }
    await this.state.update(STATE_KEY, [...this.list(), profile]);
    this.emitter.fire();
  }

  /**
   * Collapse rows that name the same FQDN — the twins an older build
   * minted on every re-sign-in. Per FQDN the row that holds a
   * credential survives, else the active one, else the first; the
   * survivor keeps its id, the losers are removed and `onLose` is given
   * their ids so their secrets can be cleared. Idempotent; returns what
   * was merged so the caller can say so once.
   */
  async dedupe(
    hasCredential: (profile: Profile) => Promise<boolean>,
    onLose: (profileId: string) => Promise<void>,
  ): Promise<Array<{ kept: Profile; removed: Profile[] }>> {
    // Only signed-in rows collapse; a bearer row is its own principal.
    const groups = new Map<string, Profile[]>();
    for (const p of this.list()) {
      const key =
        p.authMode === "zitadel" ? p.fqdn.toLowerCase() : `${p.id}\u0000bearer`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const merged: Array<{ kept: Profile; removed: Profile[] }> = [];
    const activeId = this.activeId();
    let survivors: Profile[] = [];
    for (const rows of groups.values()) {
      if (rows.length === 1) {
        survivors.push(rows[0]);
        continue;
      }
      let kept: Profile | undefined;
      for (const row of rows) {
        if (await hasCredential(row)) {
          kept = row;
          break;
        }
      }
      kept ??= rows.find((r) => r.id === activeId) ?? rows[0];
      const removed = rows.filter((r) => r.id !== kept.id);
      survivors.push(kept);
      merged.push({ kept, removed });
    }
    if (merged.length === 0) {
      return merged;
    }
    // Keep the original order of the survivors.
    const keep = new Set(survivors.map((p) => p.id));
    survivors = this.list().filter((p) => keep.has(p.id));
    await this.state.update(STATE_KEY, survivors);
    for (const { kept, removed } of merged) {
      for (const loser of removed) {
        await onLose(loser.id);
      }
      if (removed.some((r) => r.id === activeId)) {
        await this.state.update(ACTIVE_KEY, kept.id);
      }
    }
    this.emitter.fire();
    return merged;
  }

  async remove(id: string): Promise<void> {
    await this.state.update(
      STATE_KEY,
      this.list().filter((p) => p.id !== id),
    );
    if (this.activeId() === id) {
      await this.setActive(undefined);
    }
    this.emitter.fire();
  }
}
