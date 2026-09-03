/**
 * ZITADEL OIDC authorization-code + PKCE flow.
 *
 * Primary route: vscode.env.asExternalUri + a registered UriHandler on
 * `${vscode.env.uriScheme}://airdress.airdress-vscode/auth/callback`.
 * Fallback route: ephemeral RFC 8252 loopback listener on 127.0.0.1 for
 * editor forks whose uriScheme is not registered on the ZITADEL app.
 *
 * Both routes open the SYSTEM browser — no embedded webview (FR-14).
 */

/** Editor uriSchemes registered as redirect URIs on the ZITADEL native app. */
export const KNOWN_URI_SCHEMES = [
  "vscode",
  "vscode-insiders",
  "vscodium",
  "code-oss",
] as const;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/**
 * Run the interactive sign-in flow for a profile.
 *
 * TODO(SPEC-057 T6-03): implement code+PKCE against ZITADEL, including the
 * project-audience scope (`urn:zitadel:iam:org:project:id:<id>:aud`) —
 * without it the token is well-formed and rejected (design §4.2).
 */
export async function signIn(): Promise<TokenSet> {
  throw new Error("TODO(SPEC-057 T6-03): ZITADEL sign-in not implemented");
}

/**
 * TODO(SPEC-057 T6-03): refresh-token grant.
 */
export async function refresh(_refreshToken: string): Promise<TokenSet> {
  throw new Error("TODO(SPEC-057 T6-03): token refresh not implemented");
}
