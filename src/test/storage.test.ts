import * as assert from "assert";
import type * as vscode from "vscode";
import { AuthManager } from "../auth/manager";
import { SecretStore } from "../auth/store";
import { ProfileStore } from "../profiles/store";
import type { TokenSet } from "../auth/zitadel";

/**
 * Fakes for the two persistence surfaces. Everything they are handed is
 * recorded so tests can assert what was — and, critically, what was
 * NEVER — persisted.
 */

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

class FakeMemento implements vscode.Memento {
  readonly stored = new Map<string, unknown>();
  syncKeysCalls = 0;

  keys(): readonly string[] {
    return [...this.stored.keys()];
  }
  get<T>(key: string, defaultValue?: T): T {
    return (this.stored.get(key) as T) ?? (defaultValue as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    this.stored.set(key, value);
  }
  /** Mirror of globalState.setKeysForSync — must NEVER be called. */
  setKeysForSync(_keys: readonly string[]): void {
    this.syncKeysCalls++;
  }
}

const REFRESH_SECRET = "refresh-secret-value-1";
const ACCESS_SECRET = "access-token-value-1";
const BEARER_SECRET = "opaque-bearer-value-1";

function tokenSet(overrides?: Partial<TokenSet>): TokenSet {
  return {
    accessToken: ACCESS_SECRET,
    refreshToken: REFRESH_SECRET,
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

suite("SecretStore (T6-02)", () => {
  test("round-trips refresh tokens and bearers under profile-scoped keys", async () => {
    const backing = new FakeSecretStorage();
    const store = new SecretStore(backing);
    await store.setRefreshToken("p1", REFRESH_SECRET);
    await store.setBearer("p1", BEARER_SECRET);
    assert.strictEqual(await store.getRefreshToken("p1"), REFRESH_SECRET);
    assert.strictEqual(await store.getBearer("p1"), BEARER_SECRET);
    assert.deepStrictEqual([...backing.stored.keys()].sort(), [
      "airdress.profile.p1.bearer",
      "airdress.profile.p1.refresh",
    ]);
  });

  test("clearProfile removes every secret for the profile", async () => {
    const backing = new FakeSecretStorage();
    const store = new SecretStore(backing);
    await store.setRefreshToken("p1", REFRESH_SECRET);
    await store.setBearer("p1", BEARER_SECRET);
    await store.setRefreshToken("p2", "other");
    await store.clearProfile("p1");
    assert.strictEqual(await store.getRefreshToken("p1"), undefined);
    assert.strictEqual(await store.getBearer("p1"), undefined);
    assert.strictEqual(await store.getRefreshToken("p2"), "other");
  });
});

suite("AuthManager (T6-02)", () => {
  const cfg = {
    issuer: "https://issuer.test",
    clientId: "c",
    scopes: "openid",
  };

  test("access tokens are memory-only; refresh token is the only persisted credential", async () => {
    const backing = new FakeSecretStorage();
    const manager = new AuthManager(new SecretStore(backing), {
      signInFn: async () => tokenSet(),
      getConfig: () => cfg,
    });
    await manager.signInZitadel("p1", undefined as never);

    // The refresh token is in SecretStorage; the access token is NOT
    // persisted anywhere (FR-22).
    const persisted = JSON.stringify([...backing.stored.entries()]);
    assert.ok(persisted.includes(REFRESH_SECRET));
    assert.ok(
      !persisted.includes(ACCESS_SECRET),
      "access token must never reach SecretStorage",
    );
  });

  test("a valid in-memory access token is served without a refresh", async () => {
    let refreshCalls = 0;
    const manager = new AuthManager(new SecretStore(new FakeSecretStorage()), {
      signInFn: async () => tokenSet(),
      refreshFn: async () => {
        refreshCalls++;
        return tokenSet();
      },
      getConfig: () => cfg,
    });
    await manager.signInZitadel("p1", undefined as never);
    const token = await manager.getAccessToken({
      id: "p1",
      authMode: "zitadel",
    });
    assert.strictEqual(token, ACCESS_SECRET);
    assert.strictEqual(refreshCalls, 0);
  });

  test("restart re-derives the access token from the refresh token with no prompt", async () => {
    const backing = new FakeSecretStorage();
    const first = new AuthManager(new SecretStore(backing), {
      signInFn: async () => tokenSet(),
      getConfig: () => cfg,
    });
    await first.signInZitadel("p1", undefined as never);

    // "Restart": a new manager over the same SecretStorage. No sign-in
    // function is provided at all — if silent refresh does not carry
    // the day, this test fails rather than prompting.
    let refreshedWith: string | undefined;
    const second = new AuthManager(new SecretStore(backing), {
      refreshFn: async (_cfg, refreshToken) => {
        refreshedWith = refreshToken;
        return tokenSet({ accessToken: "access-2", refreshToken: "refresh-2" });
      },
      getConfig: () => cfg,
    });
    const token = await second.getAccessToken({
      id: "p1",
      authMode: "zitadel",
    });
    assert.strictEqual(token, "access-2");
    assert.strictEqual(refreshedWith, REFRESH_SECRET);
    // The rotated refresh token was persisted.
    assert.strictEqual(
      backing.stored.get("airdress.profile.p1.refresh"),
      "refresh-2",
    );
  });

  test("expired access token triggers exactly one silent refresh", async () => {
    const backing = new FakeSecretStorage();
    let refreshCalls = 0;
    const manager = new AuthManager(new SecretStore(backing), {
      signInFn: async () => tokenSet({ expiresAt: Date.now() - 1000 }),
      refreshFn: async () => {
        refreshCalls++;
        return tokenSet({ accessToken: "fresh" });
      },
      getConfig: () => cfg,
    });
    await manager.signInZitadel("p1", undefined as never);
    assert.strictEqual(
      await manager.getAccessToken({ id: "p1", authMode: "zitadel" }),
      "fresh",
    );
    assert.strictEqual(refreshCalls, 1);
  });

  test("a failed refresh returns undefined instead of throwing (single re-auth prompt upstream)", async () => {
    const backing = new FakeSecretStorage();
    const store = new SecretStore(backing);
    await store.setRefreshToken("p1", "expired");
    const manager = new AuthManager(store, {
      refreshFn: async () => {
        throw new Error("invalid_grant");
      },
      getConfig: () => cfg,
    });
    assert.strictEqual(
      await manager.getAccessToken({ id: "p1", authMode: "zitadel" }),
      undefined,
    );
  });

  test("bearer profiles read the opaque bearer from SecretStorage", async () => {
    const backing = new FakeSecretStorage();
    const manager = new AuthManager(new SecretStore(backing));
    await manager.setBearer("p1", BEARER_SECRET);
    assert.strictEqual(
      await manager.getAccessToken({ id: "p1", authMode: "bearer" }),
      BEARER_SECRET,
    );
  });

  test("signOut clears memory and every stored secret", async () => {
    const backing = new FakeSecretStorage();
    const manager = new AuthManager(new SecretStore(backing), {
      signInFn: async () => tokenSet(),
      getConfig: () => cfg,
    });
    await manager.signInZitadel("p1", undefined as never);
    await manager.setBearer("p1", BEARER_SECRET);
    await manager.signOut("p1");
    assert.strictEqual(backing.stored.size, 0);
    assert.strictEqual(
      await manager.getAccessToken({ id: "p1", authMode: "zitadel" }),
      undefined,
    );
  });
});

suite("ProfileStore persistence boundary (T6-02)", () => {
  test("profile records go to globalState; setKeysForSync is never called", async () => {
    const memento = new FakeMemento();
    const store = new ProfileStore(memento);
    await store.add({
      id: "p1",
      label: "ada",
      fqdn: "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es",
      authMode: "zitadel",
      dev: false,
    });
    assert.strictEqual(store.list().length, 1);
    // Deliberate non-sync (design §4.5): replicating a user's operator
    // inventory through Settings Sync is a disclosure even though the
    // tokens do not travel.
    assert.strictEqual(memento.syncKeysCalls, 0);
  });

  test("no credential material can appear in profile persistence", async () => {
    const memento = new FakeMemento();
    const store = new ProfileStore(memento);
    await store.add({
      id: "p1",
      label: "ada",
      fqdn: "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es",
      authMode: "bearer",
      dev: false,
    });
    const persisted = JSON.stringify([...memento.stored.entries()]);
    for (const secret of [REFRESH_SECRET, ACCESS_SECRET, BEARER_SECRET]) {
      assert.ok(!persisted.includes(secret));
    }
    // Structurally: a Profile has no field that could hold a credential.
    const profile = store.list()[0];
    assert.deepStrictEqual(Object.keys(profile).sort(), [
      "authMode",
      "dev",
      "fqdn",
      "id",
      "label",
    ]);
  });
});
