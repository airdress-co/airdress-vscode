import * as assert from "assert";
import * as vscode from "vscode";
import {
  challengeS256,
  generateState,
  generateVerifier,
  isValidVerifier,
} from "../auth/pkce";
import {
  buildAuthorizeUrl,
  CallbackRouter,
  externalUriTargetsUriHandler,
  parseCallbackQuery,
  registeredRedirectUri,
  UriHandlerTimeoutError,
  KNOWN_URI_SCHEMES,
} from "../auth/zitadel";
import { bearerPasteHint, isJwtShaped } from "../auth/bearer";

suite("PKCE (RFC 7636)", () => {
  test("derives the appendix-B challenge from the appendix-B verifier", () => {
    // RFC 7636 Appendix B: the only official test vector. The test
    // verifies the challenge VALUE — presence alone proved nothing
    // (verify values, not presence).
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    assert.strictEqual(challengeS256(verifier), expectedChallenge);
  });

  test("generated verifiers are RFC 7636-legal", () => {
    for (let i = 0; i < 32; i++) {
      const v = generateVerifier();
      assert.ok(isValidVerifier(v), `illegal verifier: ${v}`);
    }
  });

  test("challenge is base64url without padding", () => {
    const c = challengeS256(generateVerifier());
    assert.match(c, /^[A-Za-z0-9\-_]{43}$/);
  });

  test("state values are unique and non-empty", () => {
    const a = generateState();
    const b = generateState();
    assert.ok(a.length >= 16);
    assert.notStrictEqual(a, b);
  });
});

suite("authorize URL", () => {
  const cfg = {
    issuer: "https://airdress-co-tffhig.us1.zitadel.cloud",
    clientId: "389189092820182216",
    scopes:
      "openid profile email offline_access " +
      "urn:zitadel:iam:org:project:id:368173150459965108:aud",
  };

  test("carries PKCE S256, state, and the project-audience scope", () => {
    const url = new URL(
      buildAuthorizeUrl(
        cfg,
        "http://127.0.0.1:39131/callback",
        "st4te",
        "ch4llenge",
      ),
    );
    assert.strictEqual(
      url.origin,
      "https://airdress-co-tffhig.us1.zitadel.cloud",
    );
    assert.strictEqual(url.pathname, "/oauth/v2/authorize");
    assert.strictEqual(url.searchParams.get("response_type"), "code");
    assert.strictEqual(url.searchParams.get("client_id"), cfg.clientId);
    assert.strictEqual(url.searchParams.get("code_challenge"), "ch4llenge");
    assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
    assert.strictEqual(url.searchParams.get("state"), "st4te");
    // The load-bearing scope (design §4.2): without the project-audience
    // URN the token is valid everywhere except at the operator.
    const scope = url.searchParams.get("scope") ?? "";
    assert.ok(
      scope.includes("urn:zitadel:iam:org:project:id:368173150459965108:aud"),
      "project-audience scope missing from the authorization request",
    );
    assert.ok(scope.includes("offline_access"), "offline_access missing");
  });

  test("never carries a client secret", () => {
    const raw = buildAuthorizeUrl(
      cfg,
      "vscode://airdress.airdress-vscode/auth/callback",
      "s",
      "c",
    );
    assert.ok(!raw.includes("client_secret"));
  });
});

suite("registered redirect URI (exact-match discipline)", () => {
  test("the redirect_uri sent to the IdP is the BARE registered string", () => {
    // ZITADEL exact-matches redirect URIs; asExternalUri appends a
    // windowId query on desktop, which fails authorize with
    // invalid_request. The authorize URL must therefore carry the
    // registered string exactly — no query, no windowId.
    const redirect = registeredRedirectUri("vscode");
    assert.strictEqual(
      redirect,
      "vscode://airdress.airdress-vscode/auth/callback",
    );
    const url = new URL(
      buildAuthorizeUrl(
        {
          issuer: "https://airdress-co-tffhig.us1.zitadel.cloud",
          clientId: "389189092820182216",
          scopes: "openid",
        },
        redirect,
        "st4te",
        "ch4llenge",
      ),
    );
    const sent = url.searchParams.get("redirect_uri");
    assert.strictEqual(sent, "vscode://airdress.airdress-vscode/auth/callback");
    assert.ok(!sent.includes("?"), "redirect_uri must carry no query");
    assert.ok(
      !sent.includes("windowId"),
      "redirect_uri must carry no windowId",
    );
  });

  test("the environment probe tolerates an appended query", () => {
    // Desktop asExternalUri output: same scheme + authority, windowId
    // query appended. Still this extension's UriHandler.
    const desktop = vscode.Uri.parse(
      "vscode://airdress.airdress-vscode/auth/callback?windowId=_blank",
    );
    assert.strictEqual(externalUriTargetsUriHandler(desktop, "vscode"), true);
  });

  test("the environment probe rejects a rewritten external URI", () => {
    // Remote/web contexts rewrite the callback to an https tunnel form
    // the IdP does not register — such environments go to loopback.
    for (const rewritten of [
      "https://tunnel.example.test/auth/callback?vscode-scheme=vscode",
      "vscode://some.other-extension/auth/callback",
    ]) {
      assert.strictEqual(
        externalUriTargetsUriHandler(vscode.Uri.parse(rewritten), "vscode"),
        false,
        `must not treat ${rewritten} as the registered callback`,
      );
    }
  });
});

suite("callback validation", () => {
  test("accepts a matching state and returns the code", () => {
    const query = new URLSearchParams({ code: "abc", state: "expected" });
    assert.deepStrictEqual(parseCallbackQuery(query, "expected"), {
      code: "abc",
    });
  });

  test("rejects a state mismatch (CSRF)", () => {
    const query = new URLSearchParams({ code: "abc", state: "tampered" });
    assert.throws(
      () => parseCallbackQuery(query, "expected"),
      /state mismatch/,
    );
  });

  test("rejects a missing state", () => {
    const query = new URLSearchParams({ code: "abc" });
    assert.throws(
      () => parseCallbackQuery(query, "expected"),
      /state mismatch/,
    );
  });

  test("surfaces an OAuth error without leaking a code", () => {
    const query = new URLSearchParams({
      error: "access_denied",
      error_description: "user cancelled",
      state: "expected",
    });
    assert.throws(
      () => parseCallbackQuery(query, "expected"),
      /access_denied.*user cancelled/,
    );
  });

  test("rejects a callback with no code", () => {
    const query = new URLSearchParams({ state: "expected" });
    assert.throws(() => parseCallbackQuery(query, "expected"), /no code/);
  });
});

suite("CallbackRouter", () => {
  test("resolves the waiter matching the callback state", async () => {
    const router = new CallbackRouter();
    const waiting = router.waitFor("s1", 5_000);
    router.handleUri(
      vscode.Uri.parse(
        "vscode://airdress.airdress-vscode/auth/callback?code=xyz&state=s1",
      ),
    );
    const query = await waiting;
    assert.strictEqual(query.get("code"), "xyz");
  });

  test("ignores callbacks on other paths", async () => {
    const router = new CallbackRouter();
    const waiting = router.waitFor("s2", 50);
    router.handleUri(
      vscode.Uri.parse("vscode://airdress.airdress-vscode/other?state=s2"),
    );
    await assert.rejects(waiting, UriHandlerTimeoutError);
  });

  test("times out into UriHandlerTimeoutError", async () => {
    const router = new CallbackRouter();
    await assert.rejects(router.waitFor("s3", 10), UriHandlerTimeoutError);
  });
});

suite("bearer shape dispatch (operator mirror)", () => {
  test("three non-empty dot-segments are JWT-shaped", () => {
    assert.strictEqual(isJwtShaped("a.b.c"), true);
    assert.strictEqual(isJwtShaped("eyJx.eyJy.sig"), true);
  });

  test("everything else is opaque", () => {
    assert.strictEqual(isJwtShaped("a.b"), false);
    assert.strictEqual(isJwtShaped("a.b.c.d"), false);
    assert.strictEqual(isJwtShaped("a..c"), false);
    assert.strictEqual(isJwtShaped(".b.c"), false);
    assert.strictEqual(isJwtShaped("a.b."), false);
    assert.strictEqual(isJwtShaped(""), false);
    assert.strictEqual(isJwtShaped("opaque-token"), false);
  });

  test("paste hint fires only for JWT-shaped input, and never blocks", () => {
    assert.ok(bearerPasteHint("a.b.c"));
    assert.strictEqual(bearerPasteHint("opaque-token"), undefined);
  });
});

suite("route selection constants", () => {
  test("the four registered editor schemes are the known set", () => {
    assert.deepStrictEqual(
      [...KNOWN_URI_SCHEMES],
      ["vscode", "vscode-insiders", "vscodium", "code-oss"],
    );
  });
});
