import type { AuthMode } from "../profiles/model";
import { SecretStore } from "./store";
import {
  AuthConfig,
  CallbackRouter,
  getAuthConfig,
  refresh as refreshGrant,
  signIn as zitadelSignIn,
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
 */

/** Clock-skew margin: treat a token as expired this long before it is. */
const EXPIRY_SKEW_MS = 30_000;

/** The minimal slice of a profile the manager needs. */
export interface AuthTarget {
  id: string;
  authMode: AuthMode;
}

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
}

export class AuthManager {
  /** Access tokens — MEMORY ONLY, keyed by profile id (FR-22). */
  private readonly accessTokens = new Map<string, TokenSet>();
  /** The one refresh exchange in flight per profile, if any. */
  private readonly refreshing = new Map<string, Promise<string | undefined>>();
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
    };
  }

  /**
   * Interactive ZITADEL sign-in for a profile. The refresh token goes to
   * SecretStorage; the access token stays in memory.
   */
  async signInZitadel(
    profileId: string,
    router: CallbackRouter,
  ): Promise<void> {
    const tokens = await this.deps.signInFn(router);
    this.accessTokens.set(profileId, tokens);
    if (tokens.refreshToken) {
      await this.secrets.setRefreshToken(profileId, tokens.refreshToken);
    }
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

  /** The last reported outcome for a profile; `unknown` until one is. */
  outcomeFor(profileId: string): CredentialOutcome {
    return this.outcomes.get(profileId) ?? "unknown";
  }

  /** The API client saw a 401 on this profile's bearer. */
  reportUnauthorized(profileId: string): void {
    this.accessTokens.delete(profileId);
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

    const cached = this.accessTokens.get(target.id);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }

    // ONE refresh in flight per profile. After a window reload the three
    // tree views and any open panel all ask at once, each finds no cached
    // token, and each would spend the SAME refresh token. ZITADEL rotates
    // refresh tokens on use, so only the first exchange can succeed and
    // the rest fail as reuse — which, with the failure swallowed below,
    // reads as "no credential" for a profile whose secret is still there.
    // Measured 2026-09-13 on the dev host: signed in, three reloads, dead.
    const inflight = this.refreshing.get(target.id);
    if (inflight) {
      return inflight;
    }
    const refresh = this.refreshOnce(target.id).finally(() => {
      this.refreshing.delete(target.id);
    });
    this.refreshing.set(target.id, refresh);
    return refresh;
  }

  private async refreshOnce(profileId: string): Promise<string | undefined> {
    const refreshToken = await this.secrets.getRefreshToken(profileId);
    if (!refreshToken) {
      this.report(profileId, "no-credential");
      return undefined;
    }
    let tokens: TokenSet;
    try {
      tokens = await this.deps.refreshFn(this.deps.getConfig(), refreshToken);
    } catch {
      // Refresh failed (expired/revoked). The outcome is REPORTED — it
      // used to be swallowed, and a profile with a dead refresh token
      // read as signed in until a request failed. Callers still surface
      // at most one re-auth prompt per profile (design §9).
      this.report(profileId, "no-credential");
      return undefined;
    }
    this.accessTokens.set(profileId, tokens);
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
    return (
      this.accessTokens.has(target.id) ||
      (await this.secrets.getRefreshToken(target.id)) !== undefined
    );
  }

  /**
   * Move a freshly minted credential from a candidate id onto an
   * existing profile — the "sign in again" for a profile whose refresh
   * token died. The access token moves in memory, the refresh token in
   * SecretStorage; nothing stays under `fromId`.
   */
  async adoptCredential(fromId: string, toId: string): Promise<void> {
    const tokens = this.accessTokens.get(fromId);
    const refreshToken = await this.secrets.getRefreshToken(fromId);
    if (!tokens && !refreshToken) {
      throw new Error("no credential to adopt");
    }
    this.accessTokens.delete(toId);
    this.refreshing.delete(toId);
    if (tokens) {
      this.accessTokens.set(toId, tokens);
    }
    if (refreshToken) {
      await this.secrets.setRefreshToken(toId, refreshToken);
    }
    await this.signOut(fromId);
    this.report(toId, "ok");
  }

  /** Sign out: drop the in-memory token and every stored secret. */
  async signOut(profileId: string): Promise<void> {
    this.accessTokens.delete(profileId);
    await this.secrets.clearProfile(profileId);
    this.outcomes.delete(profileId);
    for (const listener of this.listeners) {
      listener({ profileId, outcome: "no-credential" });
    }
  }
}
