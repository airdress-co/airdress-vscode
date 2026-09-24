import * as assert from "assert";
import {
  AccountMismatchError,
  identityFromIdToken,
  identityText,
} from "../auth/identity";
import { buildAuthorizeUrl, type AuthConfig } from "../auth/zitadel";
import { AuthManager } from "../auth/manager";
import { SecretStore } from "../auth/store";

/**
 * Which account a sign-in uses, and how a profile stays bound to one.
 *
 * The rule these tests hold: a flow that ADDS or CHOOSES an account
 * asks which one; a flow that re-acquires a credential for an account
 * the profile is already bound to does not have to ask, but must CHECK.
 * The asking is a request to the provider — the checking is what makes
 * it true.
 */

const CFG: AuthConfig = {
  issuer: "https://issuer.example",
  clientId: "a-client",
  scopes: "openid profile",
};

function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.signature`;
}

suite("the authorization request carries the question being asked", () => {
  test("no prompt is sent when none was asked for", () => {
    const url = new URL(
      buildAuthorizeUrl(CFG, "http://127.0.0.1/cb", "s", "c"),
    );
    assert.strictEqual(url.searchParams.get("prompt"), null);
    assert.strictEqual(url.searchParams.get("login_hint"), null);
  });

  test("select_account and login_hint reach the provider verbatim", () => {
    const url = new URL(
      buildAuthorizeUrl(CFG, "http://127.0.0.1/cb", "s", "c", {
        prompt: "select_account",
        loginHint: "someone@example.test",
      }),
    );
    assert.strictEqual(url.searchParams.get("prompt"), "select_account");
    assert.strictEqual(
      url.searchParams.get("login_hint"),
      "someone@example.test",
    );
  });

  test("the type admits no silent prompt", () => {
    // `prompt=none` asks the provider to authenticate WITHOUT showing
    // anything, which turns a client into a probe for whether someone
    // is signed in. It is excluded at the type level rather than by
    // convention; this asserts the two permitted values are the ones
    // the builder actually forwards.
    for (const prompt of ["select_account", "login"] as const) {
      const url = new URL(
        buildAuthorizeUrl(CFG, "http://127.0.0.1/cb", "s", "c", { prompt }),
      );
      assert.strictEqual(url.searchParams.get("prompt"), prompt);
    }
  });
});

suite("reading who a credential belongs to", () => {
  test("the subject is taken, and a label is chosen in preference order", () => {
    assert.deepStrictEqual(
      identityFromIdToken(
        idToken({
          sub: "user-1",
          preferred_username: "ada@example.test",
          email: "other@example.test",
          name: "Ada",
        }),
      ),
      { sub: "user-1", label: "ada@example.test" },
    );
    assert.deepStrictEqual(
      identityFromIdToken(idToken({ sub: "user-2", name: "Grace" })),
      { sub: "user-2", label: "Grace" },
    );
  });

  test("a token with no usable subject yields no identity, never a partial one", () => {
    for (const bad of [
      undefined,
      "",
      "not-a-jwt",
      "two.segments",
      idToken({ email: "nobody@example.test" }),
      idToken({ sub: "" }),
      idToken({ sub: 7 }),
    ]) {
      assert.strictEqual(
        identityFromIdToken(bad as string | undefined),
        undefined,
      );
    }
    // ...and a malformed middle segment is absence, not a throw.
    assert.strictEqual(identityFromIdToken("a.!!!.c"), undefined);
  });

  test("an identity with no label reads as its subject, and an absent one says so", () => {
    assert.strictEqual(identityText({ sub: "user-3" }), "user-3");
    assert.strictEqual(identityText(undefined), "an unknown account");
  });
});

/** Minimal SecretStorage double: the manager's only persistence. */
class FakeSecrets implements Partial<import("vscode").SecretStorage> {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function managerWith(identity?: { sub: string; label?: string }): AuthManager {
  const secrets = new SecretStore(
    new FakeSecrets() as unknown as import("vscode").SecretStorage,
  );
  return new AuthManager(secrets, {
    signInFn: async () => ({
      accessToken: "an-access-token",
      refreshToken: "a-refresh-token",
      expiresAt: Date.now() + 300_000,
      identity,
    }),
  });
}

suite("a profile does not change hands", () => {
  test("adopting a credential for a different account is refused, and nothing moves", async () => {
    const auth = managerWith({
      sub: "somebody-else",
      label: "eve@example.test",
    });
    await auth.signInZitadel("candidate", undefined as never);

    await assert.rejects(
      () =>
        auth.adoptCredential("candidate", "bound-profile", {
          sub: "the-owner",
          label: "ada@example.test",
        }),
      (err: unknown) => {
        assert.ok(err instanceof AccountMismatchError);
        // The message names both accounts, because "wrong account" with
        // no names is not actionable when several are in play.
        assert.ok(err.message.includes("eve@example.test"));
        assert.ok(err.message.includes("ada@example.test"));
        return true;
      },
    );
    // The refusal happens BEFORE any write: the profile has no
    // credential, and the candidate still holds its own.
    assert.strictEqual(
      await auth.hasCredential({ id: "bound-profile", authMode: "zitadel" }),
      false,
    );
    assert.strictEqual(
      await auth.hasCredential({ id: "candidate", authMode: "zitadel" }),
      true,
    );
  });

  test("the same account is adopted, and the candidate keeps nothing", async () => {
    const auth = managerWith({ sub: "the-owner", label: "ada@example.test" });
    await auth.signInZitadel("candidate", undefined as never);
    await auth.adoptCredential("candidate", "bound-profile", {
      sub: "the-owner",
    });
    assert.strictEqual(
      await auth.hasCredential({ id: "bound-profile", authMode: "zitadel" }),
      true,
    );
    assert.strictEqual(
      await auth.hasCredential({ id: "candidate", authMode: "zitadel" }),
      false,
    );
    assert.strictEqual(auth.identityFor("bound-profile")?.sub, "the-owner");
  });

  test("an unbound profile adopts anything — an absent binding is not a wildcard match", async () => {
    // A profile created before bindings existed has nothing to compare.
    // It must still work, and the sign-in that follows fills the
    // binding in — which is what stops the NEXT one being silent.
    const auth = managerWith({ sub: "whoever", label: "new@example.test" });
    await auth.signInZitadel("candidate", undefined as never);
    await auth.adoptCredential("candidate", "unbound-profile", undefined);
    assert.strictEqual(auth.identityFor("unbound-profile")?.sub, "whoever");
  });

  test("a credential whose token named no account cannot satisfy a binding by silence", async () => {
    // No identity in the response means nothing was proven about who
    // this is. The adoption proceeds (there is no evidence of a
    // mismatch) but the binding is NOT overwritten with an absence.
    const auth = managerWith(undefined);
    await auth.signInZitadel("candidate", undefined as never);
    await auth.adoptCredential("candidate", "bound-profile", {
      sub: "the-owner",
    });
    assert.strictEqual(auth.identityFor("bound-profile"), undefined);
  });
});
