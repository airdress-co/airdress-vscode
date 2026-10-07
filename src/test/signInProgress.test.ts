import * as assert from "assert";
import * as vscode from "vscode";
import {
  SignInCancelledError,
  signInHost,
  untilCancelled,
} from "../auth/zitadel";

/**
 * The sign-in's progress notification: what it names, and that Cancel
 * ends the wait instead of leaving a silent five-minute timer.
 */
suite("sign-in progress", () => {
  test("names the host the person finishes at", () => {
    assert.strictEqual(
      signInHost({
        kind: "hub",
        issuer: "https://account.airdress.co",
        clientId: "airdress-vscode",
        scopes: "offline_access",
        authorizationEndpoint: "https://account.airdress.co/oauth/authorize",
      }),
      "account.airdress.co",
    );
    assert.strictEqual(
      signInHost({
        issuer: "https://idp.example",
        clientId: "c",
        scopes: "openid",
        authorizeBase: "https://account.airdress.co/login/authorize",
      }),
      "account.airdress.co",
    );
    assert.strictEqual(
      signInHost({
        issuer: "https://idp.example",
        clientId: "c",
        scopes: "openid",
      }),
      "idp.example",
    );
  });

  test("a result arriving first passes through", async () => {
    const source = new vscode.CancellationTokenSource();
    assert.strictEqual(
      await untilCancelled(Promise.resolve(7), source.token),
      7,
    );
    source.dispose();
  });

  test("Cancel rejects with SignInCancelledError while still waiting", async () => {
    const source = new vscode.CancellationTokenSource();
    const never = new Promise<number>(() => {});
    const waiting = untilCancelled(never, source.token);
    source.cancel();
    await assert.rejects(
      waiting,
      (err: unknown) => err instanceof SignInCancelledError,
    );
    source.dispose();
  });

  test("an already cancelled token rejects at once", async () => {
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    await assert.rejects(
      untilCancelled(Promise.resolve(1), source.token),
      (err: unknown) => err instanceof SignInCancelledError,
    );
    source.dispose();
  });
});
