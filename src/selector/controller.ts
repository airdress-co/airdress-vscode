import {
  parseSelectorAction,
  type Credential,
  type Reach,
  type SelectorAction,
  type SelectorHostMessage,
  type SelectorState,
} from "./protocol";

/**
 * The selector's state machine behind a host seam, so every state the
 * view can show and every action it can send is tested with a fake
 * host and no window (the resource panel's discipline).
 *
 * The controller owns nothing: profiles, reachability and credential
 * facts come from the host on every render, so the view is never a
 * stale copy of the extension's truth. Actions are forwarded to the
 * host as intentions ("activate this id"); the host maps them onto
 * commands.
 */
export interface SelectorHost {
  profiles(): Array<{
    id: string;
    label: string;
    fqdn: string;
    authMode: "zitadel" | "bearer";
  }>;
  activeId(): string | undefined;
  reach(profileId: string): { reach: Reach; latencyMs?: number };
  credential(profileId: string): Credential;
  activate(profileId: string): Promise<void>;
  signInAgain(profileId: string): Promise<void>;
  connect(): Promise<void>;
  /** Re-probe reachability and credential for the active profile. */
  probe(profileId: string): Promise<void>;
  post(message: SelectorHostMessage): void;
}

export class SelectorController {
  private busy = false;

  constructor(private readonly host: SelectorHost) {}

  /** The state the view should show right now. */
  state(): SelectorState {
    const profiles = this.host.profiles();
    const activeId = this.host.activeId();
    const activeProfile = activeId
      ? profiles.find((p) => p.id === activeId)
      : undefined;
    const active = activeProfile
      ? {
          ...activeProfile,
          ...this.host.reach(activeProfile.id),
          credential: this.host.credential(activeProfile.id),
        }
      : undefined;
    return { active, profiles, busy: this.busy };
  }

  /** Post the current state to the view. */
  render(): void {
    this.host.post({ type: "state", state: this.state() });
  }

  /** Entry point for every webview message; malformed ones are dropped. */
  async handle(raw: unknown): Promise<void> {
    const action = parseSelectorAction(raw);
    if (!action) {
      return;
    }
    await this.run(action);
  }

  private async run(action: SelectorAction): Promise<void> {
    switch (action.type) {
      case "load":
        this.render();
        return;
      case "switch":
        if (this.host.profiles().some((p) => p.id === action.id)) {
          await this.host.activate(action.id);
        }
        this.render();
        return;
      case "connect":
        await this.host.connect();
        this.render();
        return;
      case "signInAgain": {
        const id = this.host.activeId();
        if (!id) {
          return;
        }
        await this.withBusy(() => this.host.signInAgain(id));
        return;
      }
      case "refresh": {
        const id = this.host.activeId();
        if (!id) {
          this.render();
          return;
        }
        await this.withBusy(() => this.host.probe(id));
        return;
      }
    }
  }

  private async withBusy(work: () => Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.render();
    try {
      await work();
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
