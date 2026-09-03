import * as vscode from "vscode";
import { Profile } from "./model";

const STATE_KEY = "airdress.profiles";
const ACTIVE_KEY = "airdress.activeProfileId";

/**
 * Profile persistence in globalState.
 *
 * `setKeysForSync` is deliberately NOT called — profiles reference
 * per-machine credentials and must not roam (design §4.5).
 */
export class ProfileStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): Profile[] {
    return this.state.get<Profile[]>(STATE_KEY, []);
  }

  activeId(): string | undefined {
    return this.state.get<string>(ACTIVE_KEY);
  }

  async setActive(id: string | undefined): Promise<void> {
    await this.state.update(ACTIVE_KEY, id);
  }

  async add(profile: Profile): Promise<void> {
    // TODO(SPEC-057 T6-01): validate before persisting via validateFqdn.
    await this.state.update(STATE_KEY, [...this.list(), profile]);
  }

  async remove(id: string): Promise<void> {
    await this.state.update(
      STATE_KEY,
      this.list().filter((p) => p.id !== id),
    );
    if (this.activeId() === id) {
      await this.setActive(undefined);
    }
  }
}

/**
 * FQDN validation (FR-25).
 *
 * TODO(SPEC-057 T6-01): accept only hostname forms (the SPEC-029
 * `<uuid>.a.airdr.es` shape and custom domains); reject raw IPv4/IPv6
 * literals and bracketed IPv6 (design §5 rejected inputs).
 */
export function validateFqdn(_fqdn: string): string | undefined {
  return "TODO(SPEC-057 T6-01): FQDN validation not implemented";
}
