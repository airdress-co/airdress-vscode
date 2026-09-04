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
 * The "active" profile is UI state (status bar, quick-pick
 * pre-selection). It is NEVER an ambient default: every command
 * resolves its target profile explicitly via picker.resolveProfile
 * (NFR-8) — nothing reads activeId to decide where a request goes.
 */
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
    await this.state.update(STATE_KEY, [...this.list(), profile]);
    this.emitter.fire();
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
