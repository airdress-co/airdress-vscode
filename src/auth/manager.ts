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

interface Deps {
  refreshFn: typeof refreshGrant;
  signInFn: typeof zitadelSignIn;
  getConfig: () => AuthConfig;
}

export class AuthManager {
  /** Access tokens — MEMORY ONLY, keyed by profile id (FR-22). */
  private readonly accessTokens = new Map<string, TokenSet>();
  private readonly deps: Deps;

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
  }

  /** Store an opaque operator bearer for a profile. */
  async setBearer(profileId: string, token: string): Promise<void> {
    await this.secrets.setBearer(profileId, token);
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
      return this.secrets.getBearer(target.id);
    }

    const cached = this.accessTokens.get(target.id);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }

    const refreshToken = await this.secrets.getRefreshToken(target.id);
    if (!refreshToken) {
      return undefined;
    }
    let tokens: TokenSet;
    try {
      tokens = await this.deps.refreshFn(this.deps.getConfig(), refreshToken);
    } catch {
      // Refresh failed (expired/revoked). Callers surface a single
      // re-auth prompt per profile — never a request storm (design §9).
      return undefined;
    }
    this.accessTokens.set(target.id, tokens);
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      await this.secrets.setRefreshToken(target.id, tokens.refreshToken);
    }
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

  /** Sign out: drop the in-memory token and every stored secret. */
  async signOut(profileId: string): Promise<void> {
    this.accessTokens.delete(profileId);
    await this.secrets.clearProfile(profileId);
  }
}
