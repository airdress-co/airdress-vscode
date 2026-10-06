import * as vscode from "vscode";
import type { AuthConfig } from "./zitadel";

/**
 * The hub's own authorization server.
 *
 * The extension used to sign in to ZITADEL directly and refresh there.
 * ZITADEL bills one user-day for every day a person authenticates or
 * refreshes, so an editor left open cost a user-day a day. The hub's
 * authorization server is what the CLI (`?v=2`) and the chat app already
 * use: the person signs in once, the hub reaches ZITADEL only for that
 * sign-in, and every later token comes from the hub.
 *
 * Its tokens are per resource (RFC 8707): one for the hub's API, and one
 * per operator under `https://<fqdn>/v1`. An operator accepts only a token
 * whose audience is itself.
 *
 * Discovery mirrors the CLI: `GET {hub}/api/cli/oauth-config?v=2` names the
 * issuer and the hub's resource, and the issuer's RFC 8414 metadata names
 * the endpoints. A hub that does not serve `v=2` answers 404, and the
 * extension then signs in to ZITADEL as before.
 */

/** What the hub's authorization server publishes, as far as we use it. */
export interface HubAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The hub API's resource indicator. */
  hubResource: string;
}

/** The pre-registered first-party client (tofu `hub-oauth-clients`). */
export const DEFAULT_HUB_CLIENT_ID = "airdress-vscode";

/**
 * The scopes asked for. The server knows `offline_access`, `mcp.read` and
 * `mcp.write`; the extension needs only the refresh token. It is not an
 * OIDC provider, so `openid` would be refused.
 */
export const HUB_SCOPES = "offline_access";

/** Which server a sign-in uses (`airdress.auth.server`). */
export type AuthServerChoice = "hub" | "zitadel";

export function getAuthServerChoice(): AuthServerChoice {
  const v = vscode.workspace
    .getConfiguration("airdress.auth")
    .get<string>("server", "hub");
  return v === "zitadel" ? "zitadel" : "hub";
}

/** The hub URL (`airdress.hub.url`). */
export function getHubUrl(): string {
  return vscode.workspace
    .getConfiguration("airdress.hub")
    .get<string>("url", "https://account.airdress.co");
}

export function getHubClientId(): string {
  return vscode.workspace
    .getConfiguration("airdress.auth")
    .get<string>("hubClientId", DEFAULT_HUB_CLIENT_ID);
}

/**
 * The RFC 8707 resource indicator of an operator, from the base URL the
 * API client talks to: its origin plus `/v1`, as the CLI forms it. A
 * development base URL keeps its scheme and port.
 */
export function operatorResource(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/v1`;
}

function stringField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`the hub's authorization server did not publish ${key}`);
  }
  return v;
}

/**
 * Discover the hub's authorization server (pure but for `fetchFn`;
 * unit-tested). Resolves undefined when the hub does not offer one (404
 * on `?v=2`) — the caller then uses ZITADEL. Any other failure throws:
 * an unreachable hub is not a reason to sign in somewhere else.
 */
export async function discoverHubAuthServer(
  hubUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<HubAuthServer | undefined> {
  const configUrl = new URL("/api/cli/oauth-config", hubUrl);
  configUrl.searchParams.set("v", "2");
  const cfgResponse = await fetchFn(configUrl, {
    headers: { accept: "application/json" },
  });
  if (cfgResponse.status === 404) {
    return undefined;
  }
  if (!cfgResponse.ok) {
    throw new Error(
      `the hub answered HTTP ${cfgResponse.status} for its sign-in configuration`,
    );
  }
  const cfg = (await cfgResponse.json()) as Record<string, unknown>;
  if (cfg.version !== 2 || cfg.kind !== "hub_as") {
    return undefined;
  }
  const issuer = stringField(cfg, "issuer").replace(/\/+$/, "");
  const metaResponse = await fetchFn(
    new URL("/.well-known/oauth-authorization-server", `${issuer}/`),
    { headers: { accept: "application/json" } },
  );
  if (!metaResponse.ok) {
    throw new Error(
      `the hub's authorization server metadata answered HTTP ${metaResponse.status}`,
    );
  }
  const meta = (await metaResponse.json()) as Record<string, unknown>;
  if (meta.issuer !== issuer) {
    // RFC 8414 §3.3: the metadata must name the issuer it was fetched for.
    throw new Error(
      "the hub's authorization server metadata names another issuer",
    );
  }
  return {
    issuer,
    authorizationEndpoint: stringField(meta, "authorization_endpoint"),
    tokenEndpoint: stringField(meta, "token_endpoint"),
    hubResource:
      typeof cfg.hub_resource === "string" && cfg.hub_resource.length > 0
        ? cfg.hub_resource
        : `${issuer}/api`,
  };
}

/** The auth configuration for one resource at the hub's server (pure). */
export function hubAuthConfig(
  server: HubAuthServer,
  clientId: string,
  resource: string,
): AuthConfig {
  return {
    kind: "hub",
    issuer: server.issuer,
    clientId,
    scopes: HUB_SCOPES,
    authorizationEndpoint: server.authorizationEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    resource,
  };
}
