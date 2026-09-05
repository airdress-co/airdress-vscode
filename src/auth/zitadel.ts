import * as http from "node:http";
import * as vscode from "vscode";
import { challengeS256, generateState, generateVerifier } from "./pkce";

/**
 * ZITADEL OIDC authorization-code + PKCE flow.
 *
 * Primary route: a registered UriHandler on
 * `${vscode.env.uriScheme}://airdress.airdress-vscode/auth/callback`,
 * sent to the IdP as exactly that bare string (asExternalUri is used
 * only as an environment probe — see registeredRedirectUri).
 * Fallback route: ephemeral RFC 8252 loopback listener on 127.0.0.1 for
 * editor forks whose uriScheme is not registered on the ZITADEL app,
 * and for remote/web contexts that rewrite external URIs.
 *
 * Both routes open the SYSTEM browser — no embedded webview (FR-14).
 *
 * SECURITY: no token, code, or verifier is ever logged, at any level.
 * Errors thrown from this module carry no credential material.
 */

/** Editor uriSchemes registered as redirect URIs on the ZITADEL native app. */
export const KNOWN_URI_SCHEMES = [
  "vscode",
  "vscode-insiders",
  "vscodium",
  "code-oss",
] as const;

/** How long we wait for the UriHandler callback before offering loopback. */
const URI_HANDLER_TIMEOUT_MS = 300_000;
/** How long the loopback listener waits for the browser redirect. */
const LOOPBACK_TIMEOUT_MS = 300_000;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which accessToken expires. */
  expiresAt: number;
}

export interface AuthConfig {
  issuer: string;
  clientId: string;
  /**
   * Space-separated scopes. MUST include the ZITADEL project-audience
   * URN (`urn:zitadel:iam:org:project:id:<project_id>:aud`) — without
   * it the token is well-formed, correctly signed, and rejected by the
   * operator (design §4.2).
   */
  scopes: string;
  /**
   * Base URL for the interactive authorization request. The hub serves
   * a branded entry here and 302s to the IdP with the query passed
   * through verbatim. Empty or unset falls back to
   * `{issuer}/oauth/v2/authorize`. Token and JWKS stay on the issuer —
   * only the interactive authorize hop is branded.
   */
  authorizeBase?: string;
}

/** Read the auth configuration, falling back to the shipped defaults. */
export function getAuthConfig(): AuthConfig {
  const cfg = vscode.workspace.getConfiguration("airdress.auth");
  return {
    issuer: cfg.get<string>(
      "issuer",
      "https://airdress-co-tffhig.us1.zitadel.cloud",
    ),
    clientId: cfg.get<string>("clientId", "389189092820182216"),
    scopes: cfg.get<string>(
      "scopes",
      "openid profile email offline_access " +
        "urn:zitadel:iam:org:project:id:368173150459965108:aud",
    ),
    authorizeBase: cfg.get<string>(
      "authorizeBase",
      "https://account.airdress.co/login/authorize",
    ),
  };
}

/**
 * Build the authorization URL (pure; unit-tested). Uses the branded
 * `authorizeBase` when set; otherwise the issuer's own authorize
 * endpoint. The query is identical either way.
 */
export function buildAuthorizeUrl(
  cfg: AuthConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = cfg.authorizeBase
    ? new URL(cfg.authorizeBase)
    : new URL("/oauth/v2/authorize", cfg.issuer);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * Parse and validate an authorization callback's query (pure; unit-tested).
 *
 * Throws on an OAuth error response, a state mismatch (CSRF), or a
 * missing code. Error messages never include the code or any token.
 */
export function parseCallbackQuery(
  query: URLSearchParams,
  expectedState: string,
): { code: string } {
  const error = query.get("error");
  if (error) {
    const description = query.get("error_description") ?? "";
    throw new Error(
      `Authorization failed: ${error}${description ? ` — ${description}` : ""}`,
    );
  }
  const state = query.get("state");
  if (state !== expectedState) {
    throw new Error(
      "Authorization callback state mismatch — possible CSRF; sign-in aborted.",
    );
  }
  const code = query.get("code");
  if (!code) {
    throw new Error("Authorization callback carried no code.");
  }
  return { code };
}

/**
 * Singleton UriHandler dispatcher for
 * `<scheme>://airdress.airdress-vscode/auth/callback`.
 *
 * Registered once at activation (vscode allows a single handler per
 * extension); sign-in flows register a pending state and await it.
 */
export class CallbackRouter implements vscode.UriHandler {
  private pending = new Map<
    string,
    { resolve: (query: URLSearchParams) => void }
  >();

  handleUri(uri: vscode.Uri): void {
    if (uri.path !== "/auth/callback") {
      return;
    }
    const query = new URLSearchParams(uri.query);
    const state = query.get("state");
    if (!state) {
      return;
    }
    const waiter = this.pending.get(state);
    if (waiter) {
      this.pending.delete(state);
      waiter.resolve(query);
    }
  }

  /** Await the callback for `state`, or reject after `timeoutMs`. */
  waitFor(state: string, timeoutMs: number): Promise<URLSearchParams> {
    return new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(state);
        reject(new UriHandlerTimeoutError());
      }, timeoutMs);
      this.pending.set(state, {
        resolve: (query) => {
          clearTimeout(timer);
          resolve(query);
        },
      });
    });
  }
}

/**
 * The exact redirect URI registered on the ZITADEL native app for a
 * given editor scheme — and therefore the ONLY string that may be sent
 * as `redirect_uri`. ZITADEL exact-matches redirect URIs: any appended
 * query (asExternalUri adds a `windowId` on desktop) fails authorize
 * with invalid_request "requested redirect_uri is missing in the
 * client configuration".
 */
export function registeredRedirectUri(uriScheme: string): string {
  return `${uriScheme}://airdress.airdress-vscode/auth/callback`;
}

/**
 * Environment probe over asExternalUri: `true` when the external form
 * of the registered callback still points at this extension's
 * UriHandler (same scheme + authority, extra query tolerated — it is
 * never sent to the IdP). Remote and web contexts rewrite the URI to
 * an https tunnel form, which the ZITADEL app does not register — such
 * environments must use the loopback route instead.
 */
export function externalUriTargetsUriHandler(
  external: vscode.Uri,
  uriScheme: string,
): boolean {
  return (
    external.scheme.toLowerCase() === uriScheme.toLowerCase() &&
    external.authority.toLowerCase() === "airdress.airdress-vscode"
  );
}

/** The custom-scheme redirect never fired — offer the loopback retry. */
export class UriHandlerTimeoutError extends Error {
  constructor() {
    super(
      "The editor never received the sign-in callback. " +
        "This editor build may not register its URI scheme with the " +
        "operating system — retry using the loopback route.",
    );
    this.name = "UriHandlerTimeoutError";
  }
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postTokenEndpoint(
  issuer: string,
  body: URLSearchParams,
): Promise<TokenSet> {
  const url = new URL("/oauth/v2/token", issuer);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  let payload: TokenEndpointResponse;
  try {
    payload = (await response.json()) as TokenEndpointResponse;
  } catch {
    throw new Error(
      `Token endpoint returned HTTP ${response.status} with a non-JSON body.`,
    );
  }
  if (!response.ok || !payload.access_token) {
    // Deliberately surfaces only the OAuth error code + description —
    // never any part of a token or code.
    const code = payload.error ?? `http_${response.status}`;
    const description = payload.error_description ?? "";
    throw new Error(
      `Token request failed: ${code}${description ? ` — ${description}` : ""}`,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
  };
}

/** Exchange an authorization code for tokens (PKCE — no client secret). */
export async function exchangeCode(
  cfg: AuthConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenSet> {
  return postTokenEndpoint(
    cfg.issuer,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  );
}

/** Silent refresh via the refresh-token grant. */
export async function refresh(
  cfg: AuthConfig,
  refreshToken: string,
): Promise<TokenSet> {
  return postTokenEndpoint(
    cfg.issuer,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      refresh_token: refreshToken,
      scope: cfg.scopes,
    }),
  );
}

/** Minimal page shown in the browser tab after the loopback redirect. */
const LOOPBACK_RESPONSE_HTML =
  "<!doctype html><meta charset='utf-8'><title>Airdress</title>" +
  "<body style='font-family:system-ui;padding:2rem'>" +
  "<p>Sign-in complete — you can close this tab and return to the editor.</p>";

/**
 * RFC 8252 §7.3 loopback flow: ephemeral listener on 127.0.0.1, any port.
 * ZITADEL accepts loopback redirects for native clients regardless of port.
 */
async function signInViaLoopback(cfg: AuthConfig): Promise<TokenSet> {
  const verifier = generateVerifier();
  const state = generateState();

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Loopback listener failed to bind.");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;

  try {
    const queryPromise = new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for the sign-in redirect."));
      }, LOOPBACK_TIMEOUT_MS);
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${address.port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(LOOPBACK_RESPONSE_HTML);
        clearTimeout(timer);
        resolve(url.searchParams);
      });
    });

    const authorizeUrl = buildAuthorizeUrl(
      cfg,
      redirectUri,
      state,
      challengeS256(verifier),
    );
    await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));

    const query = await queryPromise;
    const { code } = parseCallbackQuery(query, state);
    return await exchangeCode(cfg, code, verifier, redirectUri);
  } finally {
    server.close();
  }
}

/** Custom-scheme flow through the registered UriHandler. */
async function signInViaUriHandler(
  cfg: AuthConfig,
  router: CallbackRouter,
): Promise<TokenSet> {
  const verifier = generateVerifier();
  const state = generateState();

  // The IdP gets the BARE registered string — authorize AND token
  // exchange. asExternalUri output is never sent: on desktop it appends
  // a windowId query, and ZITADEL exact-matches redirect URIs. The
  // UriHandler fires globally, so losing the windowId is acceptable.
  const redirectUri = registeredRedirectUri(vscode.env.uriScheme);

  const authorizeUrl = buildAuthorizeUrl(
    cfg,
    redirectUri,
    state,
    challengeS256(verifier),
  );
  await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));

  const query = await router.waitFor(state, URI_HANDLER_TIMEOUT_MS);
  const { code } = parseCallbackQuery(query, state);
  return exchangeCode(cfg, code, verifier, redirectUri);
}

/**
 * Pure route selection (unit-tested). `airdress.auth.route` set to
 * "loopback" always wins: the loopback listener binds to this exact
 * extension-host process, so it is immune to the OS delivering a
 * custom-scheme callback to the wrong editor instance when several run
 * side by side. Under "auto", a uriScheme outside the set registered
 * on the ZITADEL app goes to loopback; anything else starts on the
 * UriHandler route.
 */
export function selectRoute(
  route: string,
  uriScheme: string,
): "uri-handler" | "loopback" {
  if (route === "loopback") {
    return "loopback";
  }
  return (KNOWN_URI_SCHEMES as readonly string[]).includes(uriScheme)
    ? "uri-handler"
    : "loopback";
}

/**
 * Run the interactive sign-in flow.
 *
 * Route selection is not heuristic (design §4.3): see selectRoute. A
 * known scheme whose handler never fires gets an explicit loopback
 * retry offer rather than a silent hang.
 */
export async function signIn(router: CallbackRouter): Promise<TokenSet> {
  const cfg = getAuthConfig();

  const route = vscode.workspace
    .getConfiguration("airdress.auth")
    .get<string>("route", "auto");
  if (selectRoute(route, vscode.env.uriScheme) === "loopback") {
    return signInViaLoopback(cfg);
  }

  // asExternalUri as an environment PROBE only: when it rewrites the
  // callback away from the vscode-scheme form (remote / web contexts),
  // the registered redirect can never reach this extension's
  // UriHandler — go straight to loopback.
  const probe = await vscode.env.asExternalUri(
    vscode.Uri.parse(registeredRedirectUri(vscode.env.uriScheme)),
  );
  if (!externalUriTargetsUriHandler(probe, vscode.env.uriScheme)) {
    return signInViaLoopback(cfg);
  }

  try {
    return await signInViaUriHandler(cfg, router);
  } catch (err) {
    if (err instanceof UriHandlerTimeoutError) {
      const retry = await vscode.window.showWarningMessage(
        err.message,
        "Retry via loopback",
      );
      if (retry === "Retry via loopback") {
        return signInViaLoopback(cfg);
      }
    }
    throw err;
  }
}
