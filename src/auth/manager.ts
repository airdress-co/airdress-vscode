import type { AuthMode } from "../profiles/model";
import { AccountMismatchError, type AccountIdentity } from "./identity";
import { SecretStore } from "./store";
import {
  discoverHubAuthServer,
  getAuthServerChoice,
  getHubClientId,
  getHubUrl,
  hubAuthConfig,
  operatorResource,
  type AuthServerChoice,
  type HubAuthServer,
} from "./hubAs";
import {
  AuthConfig,
  CallbackRouter,
  getAuthConfig,
  refresh as refreshGrant,
  signIn as zitadelSignIn,
  type SignInOptions,
  TokenSet,
} from "./zitadel";

/**
 * Credential manager.
 *
 * Storage rules, enforced here and nowhere else:
 *
 * - Refresh tokens and opaque bearers live in SecretStorage (OS keychain)
 *   via {@link SecretStore} — the only module that touches secrets.
 * - Access tokens live in THIS map, in memory, for the extension-host
 *   lifetime only. They are never persisted anywhere.
 * - Nothing here ever writes to settings.json, workspace state, or any
 *   workspace file.
 * - Nothing is logged: no token, no fragment of one, at any level.
 *
 * Two authorization servers. A profile signed in since
 * the extension moved to the hub holds a grant at the hub's server and
 * one access token PER RESOURCE (RFC 8707): the hub API, and each
 * operator under `https://<fqdn>/v1`. A profile signed in before that
 * holds a ZITADEL refresh token and one token for everything, and keeps
 * working until it next signs in. SecretStorage records which
 * (`SecretStore.getServer`).
 */

/** Clock-skew margin: treat a token as expired this long before it is. */
const EXPIRY_SKEW_MS = 30_000;

/** The minimal slice of a profile the manager needs. */
export interface AuthTarget {
  id: string;
  authMode: AuthMode;
  /**
   * Who the token is for, at the hub's server: an operator, by the base
   * URL its API client talks to. Absent: the hub's API. A ZITADEL profile
   * has one token for both and ignores this.
   */
  audience?: { operatorBaseUrl: string };
}

/** Map key for an access token: a profile, and the resource it is for. */
function tokenKey(profileId: string, resource: string): string {
  return `${profileId}\u0000${resource}`;
}

/** ZITADEL profiles hold one token, under the empty resource. */
const ZITADEL_RESOURCE = "";

/**
 * What the last thing that touched a profile's credential learned.
 * A FACT about the credential, reported by the code that observed it —
 * never inferred from "a secret exists": a stored refresh token whose
 * silent refresh fails is `no-credential`, and an operator answering
 * 401 is `unauthorized`, both the moment they happen.
 */
export type CredentialOutcome =
  "ok" | "unauthorized" | "no-credential" | "unknown";

export interface CredentialChange {
  profileId: string;
  outcome: CredentialOutcome;
}

interface Deps {
  refreshFn: typeof refreshGrant;
  signInFn: typeof zitadelSignIn;
  getConfig: () => AuthConfig;
  /** Which server a NEW sign-in uses (`airdress.auth.server`). */
  serverChoice: () => AuthServerChoice;
  /** The hub's authorization server, or undefined if the hub has none. */
  discoverHub: () => Promise<HubAuthServer | undefined>;
  hubClientId: () => string;
}

export class AuthManager {
  /** Access tokens — MEMORY ONLY, keyed by profile and resource (FR-22). */
  private readonly accessTokens = new Map<string, TokenSet>();
  /** The account each profile's credential belongs to, from sign-in. */
  private readonly identities = new Map<string, AccountIdentity>();
  /** The one refresh exchange in flight per profile and resource. */
  private readonly refreshing = new Map<string, Promise<string | undefined>>();
  /**
   * The tail of each profile's chain of hub refreshes. The hub rotates the
   * refresh token on every use and revokes the whole grant when an old one
   * comes back, so two resources of one profile are never refreshed at
   * once (the CLI holds a lock for the same reason).
   */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Discovery of the hub's server, once per extension host. */
  private hubServer?: Promise<HubAuthServer | undefined>;
  private readonly deps: Deps;
  /** Last reported outcome per profile — what the selector shows. */
  private readonly outcomes = new Map<string, CredentialOutcome>();
  private readonly listeners = new Set<(change: CredentialChange) => void>();

  constructor(
    private readonly secrets: SecretStore,
    deps?: Partial<Deps>,
  ) {
    this.deps = {
      refreshFn: deps?.refreshFn ?? refreshGrant,
      signInFn: deps?.signInFn ?? zitadelSignIn,
      getConfig: deps?.getConfig ?? getAuthConfig,
      serverChoice: deps?.serverChoice ?? getAuthServerChoice,
      discoverHub:
        deps?.discoverHub ?? (() => discoverHubAuthServer(getHubUrl())),
      hubClientId: deps?.hubClientId ?? getHubClientId,
    };
  }

  /** The hub's server, discovered once; a failed discovery is retried. */
  private discoverHub(): Promise<HubAuthServer | undefined> {
    if (!this.hubServer) {
      this.hubServer = this.deps.discoverHub().catch((err: unknown) => {
        this.hubServer = undefined;
        throw err;
      });
    }
    return this.hubServer;
  }

  /** Every cached access token of a profile goes. */
  private dropTokens(profileId: string): void {
    for (const key of [...this.accessTokens.keys()]) {
      if (key.startsWith(`${profileId}\u0000`)) {
        this.accessTokens.delete(key);
      }
    }
  }

  /**
   * Interactive ZITADEL sign-in for a profile. The refresh token goes to
   * SecretStorage; the access token stays in memory.
   */
  async signInZitadel(
    profileId: string,
    router: CallbackRouter,
    options: SignInOptions = {},
  ): Promise<void> {
    // The hub's server when it has one and the setting allows it; an
    // unreachable hub throws rather than quietly signing in elsewhere.
    const hub =
      this.deps.serverChoice() === "hub" ? await this.discoverHub() : undefined;
    let tokens: TokenSet;
    let resource: string;
    if (hub) {
      // The first token is for the hub's API: connecting an airdress
      // lists them there. Operator tokens follow from the same grant.
      resource = hub.hubResource;
      tokens = await this.deps.signInFn(
        router,
        options,
        hubAuthConfig(hub, this.deps.hubClientId(), resource),
      );
    } else {
      resource = ZITADEL_RESOURCE;
      tokens = await this.deps.signInFn(router, options);
    }
    this.dropTokens(profileId);
    this.accessTokens.set(tokenKey(profileId, resource), tokens);
    if (tokens.identity) {
      this.identities.set(profileId, tokens.identity);
    }
    if (tokens.refreshToken) {
      await this.secrets.setRefreshToken(profileId, tokens.refreshToken);
    }
    await this.secrets.setServer(profileId, hub ? "hub" : "zitadel");
    this.report(profileId, "ok");
  }

  /**
   * Subscribe to credential outcomes. The payload names a profile id and
   * an outcome — never a token or a fragment of one (a test greps it).
   */
  onDidChangeCredential(listener: (change: CredentialChange) => void): {
    dispose(): void;
  } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * The account the profile's current in-memory credential belongs to,
   * or undefined when there is none or the response carried no id
   * token. Callers persist it onto the profile as the binding.
   */
  identityFor(profileId: string): AccountIdentity | undefined {
    return this.identities.get(profileId);
  }

  /** The last reported outcome for a profile; `unknown` until one is. */
  outcomeFor(profileId: string): CredentialOutcome {
    return this.outcomes.get(profileId) ?? "unknown";
  }

  /** The API client saw a 401 on this profile's bearer. */
  reportUnauthorized(profileId: string): void {
    this.dropTokens(profileId);
    this.report(profileId, "unauthorized");
  }

  private report(profileId: string, outcome: CredentialOutcome): void {
    if (this.outcomes.get(profileId) === outcome) {
      return;
    }
    this.outcomes.set(profileId, outcome);
    for (const listener of this.listeners) {
      listener({ profileId, outcome });
    }
  }

  /** Store an opaque operator bearer for a profile. */
  async setBearer(profileId: string, token: string): Promise<void> {
    await this.secrets.setBearer(profileId, token);
    this.report(profileId, "ok");
  }

  /**
   * Resolve the bearer value to send for a profile, or undefined when a
   * fresh interactive sign-in is required.
   *
   * ZITADEL profiles: an unexpired in-memory access token is returned
   * as-is; otherwise a silent refresh runs against the stored refresh
   * token (FR-19) — so an editor restart re-derives the access token
   * with no prompt. A rotated refresh token is persisted in the same
   * step.
   */
  async getAccessToken(target: AuthTarget): Promise<string | undefined> {
    if (target.authMode === "bearer") {
      const bearer = await this.secrets.getBearer(target.id);
      if (!bearer) {
        this.report(target.id, "no-credential");
      }
      return bearer;
    }

    const server = await this.secrets.getServer(target.id);
    let hub: HubAuthServer | undefined;
    let resource = ZITADEL_RESOURCE;
    if (server === "hub") {
      try {
        hub = await this.discoverHub();
      } catch {
        hub = undefined;
      }
      if (!hub) {
        // A hub grant with no hub to renew it at: say so, do not guess.
        this.report(target.id, "no-credential");
        return undefined;
      }
      resource = target.audience
        ? operatorResource(target.audience.operatorBaseUrl)
        : hub.hubResource;
    }
    const key = tokenKey(target.id, resource);

    const cached = this.accessTokens.get(key);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }

    // ONE refresh in flight per profile and resource. After a window
    // reload the three tree views and any open panel all ask at once,
    // each finds no cached token, and each would spend the SAME refresh
    // token. Both servers rotate refresh tokens on use, so only the first
    // exchange can succeed and the rest fail as reuse — which, with the
    // failure swallowed below, reads as "no credential" for a profile
    // whose secret is still there. Measured 2026-09-13 on the dev host:
    // signed in, three reloads, dead.
    const inflight = this.refreshing.get(key);
    if (inflight) {
      return inflight;
    }
    const run = (): Promise<string | undefined> =>
      this.refreshOnce(target.id, key, hub, resource);
    // At the hub, different resources of one profile also share the one
    // rotating refresh token: queue them behind each other.
    const previous = this.chains.get(target.id) ?? Promise.resolve();
    const refresh = previous
      .catch(() => undefined)
      .then(run)
      .finally(() => {
        this.refreshing.delete(key);
      });
    this.chains.set(target.id, refresh);
    this.refreshing.set(key, refresh);
    return refresh;
  }

  private async refreshOnce(
    profileId: string,
    key: string,
    hub: HubAuthServer | undefined,
    resource: string,
  ): Promise<string | undefined> {
    // Queued behind another refresh of this resource that already
    // finished: use what it left.
    const cached = this.accessTokens.get(key);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }
    const refreshToken = await this.secrets.getRefreshToken(profileId);
    if (!refreshToken) {
      this.report(profileId, "no-credential");
      return undefined;
    }
    const config = hub
      ? hubAuthConfig(hub, this.deps.hubClientId(), resource)
      : this.deps.getConfig();
    let tokens: TokenSet;
    try {
      tokens = await this.deps.refreshFn(config, refreshToken);
    } catch {
      // Refresh failed (expired/revoked, or at the hub a resource this
      // account may not have). The outcome is REPORTED — it used to be
      // swallowed, and a profile with a dead refresh token read as
      // signed in until a request failed. Callers still surface at most
      // one re-auth prompt per profile (design §9).
      this.report(profileId, "no-credential");
      return undefined;
    }
    this.accessTokens.set(key, tokens);
    if (tokens.identity && !this.identities.has(profileId)) {
      this.identities.set(profileId, tokens.identity);
    }
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      await this.secrets.setRefreshToken(profileId, tokens.refreshToken);
    }
    this.report(profileId, "ok");
    return tokens.accessToken;
  }

  /** Whether a profile currently has any credential at all. */
  async hasCredential(target: AuthTarget): Promise<boolean> {
    if (target.authMode === "bearer") {
      return (await this.secrets.getBearer(target.id)) !== undefined;
    }
    const prefix = `${target.id}\u0000`;
    return (
      [...this.accessTokens.keys()].some((k) => k.startsWith(prefix)) ||
      (await this.secrets.getRefreshToken(target.id)) !== undefined
    );
  }

  /**
   * Move a freshly minted credential from a candidate id onto an
   * existing profile — the "sign in again" for a profile whose refresh
   * token died. The access token moves in memory, the refresh token in
   * SecretStorage; nothing stays under `fromId`.
   */
  async adoptCredential(
    fromId: string,
    toId: string,
    expected?: AccountIdentity,
  ): Promise<void> {
    const fromPrefix = `${fromId}\u0000`;
    const tokens = [...this.accessTokens.entries()].filter(([k]) =>
      k.startsWith(fromPrefix),
    );
    const refreshToken = await this.secrets.getRefreshToken(fromId);
    if (tokens.length === 0 && !refreshToken) {
      throw new Error("no credential to adopt");
    }
    // A profile bound to an account takes credentials for THAT account
    // and no other. `prompt` asks the provider to show a chooser; what
    // comes back is whatever was picked there, or whatever session the
    // browser already held. This is the check that makes the binding
    // real, and it happens before anything is written.
    const identity = this.identities.get(fromId);
    if (expected && identity && identity.sub !== expected.sub) {
      throw new AccountMismatchError(expected, identity);
    }
    const server = await this.secrets.getServer(fromId);
    this.dropTokens(toId);
    for (const [k] of [...this.refreshing.entries()]) {
      if (k.startsWith(`${toId}\u0000`)) {
        this.refreshing.delete(k);
      }
    }
    this.chains.delete(toId);
    for (const [k, v] of tokens) {
      this.accessTokens.set(tokenKey(toId, k.slice(fromPrefix.length)), v);
    }
    if (identity) {
      this.identities.set(toId, identity);
    }
    if (refreshToken) {
      await this.secrets.setRefreshToken(toId, refreshToken);
    }
    await this.secrets.setServer(toId, server);
    await this.signOut(fromId);
    this.report(toId, "ok");
  }

  /** Sign out: drop the in-memory token and every stored secret. */
  async signOut(profileId: string): Promise<void> {
    this.dropTokens(profileId);
    this.identities.delete(profileId);
    this.chains.delete(profileId);
    await this.secrets.clearProfile(profileId);
    this.outcomes.delete(profileId);
    for (const listener of this.listeners) {
      listener({ profileId, outcome: "no-credential" });
    }
  }
}
