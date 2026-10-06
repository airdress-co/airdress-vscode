import * as assert from "assert";
import type * as vscode from "vscode";
import {
  discoverHubAuthServer,
  hubAuthConfig,
  operatorResource,
  type HubAuthServer,
} from "../auth/hubAs";
import { AuthManager } from "../auth/manager";
import { SecretStore } from "../auth/store";
import {
  buildAuthorizeUrl,
  type AuthConfig,
  type TokenSet,
} from "../auth/zitadel";

/**
 * Signing in through the hub's authorization server:
 * discovery as the CLI does it, a token per resource (RFC 8707), and a
 * refresh token that rotates on every use and kills the grant when an old
 * one comes back — so refreshes of one profile never overlap.
 */

const HUB = "https://hub.test";
const SERVER: HubAuthServer = {
  issuer: HUB,
  authorizationEndpoint: `${HUB}/oauth/authorize`,
  tokenEndpoint: `${HUB}/oauth/token`,
  hubResource: `${HUB}/api`,
};

class FakeSecretStorage implements vscode.SecretStorage {
  readonly stored = new Map<string, string>();
  onDidChange = (() => ({
    dispose() {},
  })) as unknown as vscode.Event<vscode.SecretStorageChangeEvent>;
  async get(key: string): Promise<string | undefined> {
    return this.stored.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.stored.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.stored.delete(key);
  }
  keys(): Thenable<string[]> {
    return Promise.resolve([...this.stored.keys()]);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A JWT-shaped access token naming `sub`, as the hub's server mints one. */
function accessToken(sub: string, aud: string): string {
  const seg = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ typ: "at+jwt" })}.${seg({ sub, aud })}.sig`;
}

suite("hub authorization server: discovery", () => {
  test("reads the issuer and resource, then the RFC 8414 endpoints", async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: URL | string) => {
      const u = String(url);
      asked.push(u);
      if (u === `${HUB}/api/cli/oauth-config?v=2`) {
        return jsonResponse(200, {
          version: 2,
          kind: "hub_as",
          issuer: HUB,
          client_id: "airdress-cli",
          hub_resource: `${HUB}/api`,
        });
      }
      if (u === `${HUB}/.well-known/oauth-authorization-server`) {
        return jsonResponse(200, {
          issuer: HUB,
          authorization_endpoint: `${HUB}/oauth/authorize`,
          token_endpoint: `${HUB}/oauth/token`,
        });
      }
      return jsonResponse(404, {});
    }) as typeof fetch;
    assert.deepStrictEqual(await discoverHubAuthServer(HUB, fetchFn), SERVER);
    assert.strictEqual(asked.length, 2);
  });

  test("a hub without the server (404) means: sign in to ZITADEL", async () => {
    const fetchFn = (async () => jsonResponse(404, {})) as typeof fetch;
    assert.strictEqual(await discoverHubAuthServer(HUB, fetchFn), undefined);
  });

  test("metadata naming another issuer is refused (RFC 8414 §3.3)", async () => {
    const fetchFn = (async (url: URL | string) =>
      String(url).includes("oauth-config")
        ? jsonResponse(200, { version: 2, kind: "hub_as", issuer: HUB })
        : jsonResponse(200, {
            issuer: "https://evil.test",
            authorization_endpoint: "https://evil.test/a",
            token_endpoint: "https://evil.test/t",
          })) as typeof fetch;
    await assert.rejects(discoverHubAuthServer(HUB, fetchFn));
  });

  test("an unreachable hub throws rather than falling back", async () => {
    const fetchFn = (async () => jsonResponse(503, {})) as typeof fetch;
    await assert.rejects(discoverHubAuthServer(HUB, fetchFn));
  });
});

suite("hub authorization server: resources and the authorize URL", () => {
  test("an operator's resource is its origin plus /v1", () => {
    assert.strictEqual(
      operatorResource("https://abc.a.airdr.es"),
      "https://abc.a.airdr.es/v1",
    );
    assert.strictEqual(
      operatorResource("http://127.0.0.1:8080"),
      "http://127.0.0.1:8080/v1",
    );
  });

  test("the authorize URL goes to the hub, names the resource, asks no ZITADEL scope", () => {
    const cfg = hubAuthConfig(SERVER, "airdress-vscode", SERVER.hubResource);
    const url = new URL(
      buildAuthorizeUrl(
        cfg,
        "vscode://airdress.airdress-vscode/auth/callback",
        "s",
        "c",
      ),
    );
    assert.strictEqual(
      `${url.origin}${url.pathname}`,
      `${HUB}/oauth/authorize`,
    );
    assert.strictEqual(url.searchParams.get("client_id"), "airdress-vscode");
    assert.strictEqual(url.searchParams.get("resource"), `${HUB}/api`);
    assert.strictEqual(url.searchParams.get("scope"), "offline_access");
  });
});

suite("hub authorization server: the manager", () => {
  const sub = "upstream-sub-1";

  /** A server whose refresh tokens are single-use, like the hub's. */
  function rotatingServer() {
    let generation = 0;
    const spent = new Set<string>();
    const calls: AuthConfig[] = [];
    let inFlight = 0;
    let overlapped = false;
    const refreshFn = async (
      cfg: AuthConfig,
      refreshToken: string,
    ): Promise<TokenSet> => {
      calls.push(cfg);
      inFlight += 1;
      overlapped ||= inFlight > 1;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (spent.has(refreshToken)) {
        throw new Error("invalid_grant: refresh token reused");
      }
      spent.add(refreshToken);
      generation += 1;
      return {
        accessToken: accessToken(sub, cfg.resource ?? ""),
        refreshToken: `refresh-${generation}`,
        expiresAt: Date.now() + 900_000,
      };
    };
    return { refreshFn, calls, overlapped: () => overlapped };
  }

  async function signedIn(
    backing: FakeSecretStorage,
    server = rotatingServer(),
  ) {
    let discoveries = 0;
    const manager = new AuthManager(new SecretStore(backing), {
      serverChoice: () => "hub",
      discoverHub: async () => {
        discoveries += 1;
        return SERVER;
      },
      hubClientId: () => "airdress-vscode",
      signInFn: async (_router, _options, cfg) => ({
        accessToken: accessToken(sub, cfg?.resource ?? ""),
        refreshToken: "refresh-0",
        expiresAt: Date.now() + 900_000,
        identity: { sub },
      }),
      refreshFn: server.refreshFn,
      getConfig: () => {
        throw new Error("a hub profile never reads the ZITADEL config");
      },
    });
    await manager.signInZitadel("p1", undefined as never);
    return { manager, server, discoveries: () => discoveries };
  }

  test("a sign-in through the hub is recorded, and its first token is for the hub API", async () => {
    const backing = new FakeSecretStorage();
    const { manager, server } = await signedIn(backing);
    assert.strictEqual(backing.stored.get("airdress.profile.p1.server"), "hub");
    const token = await manager.getAccessToken({
      id: "p1",
      authMode: "zitadel",
    });
    assert.ok(token?.includes("."), "a cached JWT-shaped token");
    assert.strictEqual(server.calls.length, 0, "no refresh for the hub API");
    assert.deepStrictEqual(manager.identityFor("p1"), { sub });
  });

  test("an operator's token comes from the same grant, for that operator only", async () => {
    const backing = new FakeSecretStorage();
    const { manager, server } = await signedIn(backing);
    await manager.getAccessToken({
      id: "p1",
      authMode: "zitadel",
      audience: { operatorBaseUrl: "https://op.a.airdr.es" },
    });
    assert.strictEqual(server.calls.length, 1);
    assert.strictEqual(server.calls[0].kind, "hub");
    assert.strictEqual(server.calls[0].resource, "https://op.a.airdr.es/v1");
    assert.strictEqual(server.calls[0].tokenEndpoint, `${HUB}/oauth/token`);
    // The rotated refresh token is what is stored now.
    assert.strictEqual(
      backing.stored.get("airdress.profile.p1.refresh"),
      "refresh-1",
    );
  });

  test("two operators asked at once refresh one after the other, and both succeed", async () => {
    const backing = new FakeSecretStorage();
    const { manager, server } = await signedIn(backing);
    const [a, b] = await Promise.all([
      manager.getAccessToken({
        id: "p1",
        authMode: "zitadel",
        audience: { operatorBaseUrl: "https://a.a.airdr.es" },
      }),
      manager.getAccessToken({
        id: "p1",
        authMode: "zitadel",
        audience: { operatorBaseUrl: "https://b.a.airdr.es" },
      }),
    ]);
    assert.ok(a && b, "both resources got a token");
    assert.strictEqual(
      server.overlapped(),
      false,
      "the refreshes never overlapped",
    );
    assert.strictEqual(manager.outcomeFor("p1"), "ok");
  });

  test("a profile signed in to ZITADEL before the move keeps refreshing there", async () => {
    const backing = new FakeSecretStorage();
    backing.stored.set("airdress.profile.old.refresh", "zitadel-refresh");
    let discovered = false;
    let refreshedAt: AuthConfig | undefined;
    const manager = new AuthManager(new SecretStore(backing), {
      serverChoice: () => "hub",
      discoverHub: async () => {
        discovered = true;
        return SERVER;
      },
      refreshFn: async (cfg) => {
        refreshedAt = cfg;
        return { accessToken: "z", expiresAt: Date.now() + 900_000 };
      },
      getConfig: () => ({
        issuer: "https://zitadel.test",
        clientId: "z",
        scopes: "openid",
      }),
    });
    const token = await manager.getAccessToken({
      id: "old",
      authMode: "zitadel",
      audience: { operatorBaseUrl: "https://op.a.airdr.es" },
    });
    assert.strictEqual(token, "z");
    assert.strictEqual(refreshedAt?.issuer, "https://zitadel.test");
    assert.strictEqual(
      discovered,
      false,
      "a ZITADEL profile never asks the hub",
    );
  });

  test("sign-out removes the server marker with the refresh token", async () => {
    const backing = new FakeSecretStorage();
    const { manager } = await signedIn(backing);
    await manager.signOut("p1");
    assert.strictEqual(
      backing.stored.get("airdress.profile.p1.server"),
      undefined,
    );
    assert.strictEqual(
      backing.stored.get("airdress.profile.p1.refresh"),
      undefined,
    );
  });
});
