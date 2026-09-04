import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  breakGlassState,
  breakGlassText,
  breakGlassTooltip,
  classifyBearer,
} from "../auth/breakGlass";

suite("break-glass state — visible, never actionable", () => {
  test("an owner session on an OPAQUE bearer is break-glass", () => {
    assert.strictEqual(
      breakGlassState({
        authMode: "bearer",
        bearerShape: "opaque",
        isOwner: true,
      }),
      "break-glass",
    );
  });

  test("an OIDC-authenticated owner session shows NO break-glass state", () => {
    assert.strictEqual(
      breakGlassState({ authMode: "zitadel", isOwner: true }),
      "normal",
    );
  });

  test("a JWT-shaped bearer, a sub-user bearer, and unknown ownership are all NOT break-glass", () => {
    // JWT-shaped paste into the bearer slot: not the opaque shape.
    assert.strictEqual(
      breakGlassState({
        authMode: "bearer",
        bearerShape: "jwt",
        isOwner: true,
      }),
      "normal",
    );
    // Opaque bearer but NOT an owner: a routine sub-user credential.
    assert.strictEqual(
      breakGlassState({
        authMode: "bearer",
        bearerShape: "opaque",
        isOwner: false,
      }),
      "normal",
    );
    // Ownership not yet probed: never CLAIM break-glass on a guess.
    assert.strictEqual(
      breakGlassState({
        authMode: "bearer",
        bearerShape: "opaque",
        isOwner: undefined,
      }),
      "normal",
    );
    // No stored bearer at all:
    assert.strictEqual(
      breakGlassState({
        authMode: "bearer",
        bearerShape: undefined,
        isOwner: true,
      }),
      "normal",
    );
  });

  test("the indicator surfaces the credential's SHAPE and never any part of its value", () => {
    const token = "super-secret-break-glass-token-value";
    assert.strictEqual(classifyBearer(token), "opaque");
    assert.strictEqual(classifyBearer("a.b.c"), "jwt");
    assert.strictEqual(classifyBearer(undefined), undefined);
    const text = breakGlassText("ada.a.airdr.es");
    const tooltip = breakGlassTooltip("ada.a.airdr.es");
    assert.match(text, /break-glass/);
    assert.match(text, /ada\.a\.airdr\.es/);
    for (const rendered of [text, tooltip]) {
      assert.ok(!rendered.includes(token));
      assert.ok(!rendered.includes("super-secret"));
    }
    // And the renderers cannot even receive the value: they take the
    // FQDN only (arity-checked so a refactor cannot quietly widen it).
    assert.strictEqual(breakGlassText.length, 1);
    assert.strictEqual(breakGlassTooltip.length, 1);
  });

  test("clicking routes to the owner-token recovery runbook command", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
    ) as { contributes: { commands: Array<{ command: string }> } };
    assert.ok(
      pkg.contributes.commands.some(
        (c) => c.command === "airdress.breakGlass.openRunbook",
      ),
    );
  });
});

suite("no mint path exists — a deliberate decision, not an oversight", () => {
  // WHY this assertion exists: the security property of break-glass
  // owner-token minting is not that it is audited — it is that it
  // requires BEING ON THE BOX (a host-shell command). Putting the same
  // capability behind a network-reachable client would convert a
  // possession-bound credential into one that any compromised laptop
  // session with a valid owner token can mint more of; an audit event
  // would make that visible after the fact, not safe. The project's
  // research record suggested a "loud" mint action; the design
  // deliberately diverges and ships visibility with NO mint action.
  // If a mint action is ever genuinely wanted, it needs an
  // operator-side endpoint with its own threat model — not this
  // extension shelling out over HTTP.

  test("no contributed command mints, prints or recovers an owner token", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
    ) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    for (const cmd of pkg.contributes.commands) {
      const surface = `${cmd.command} ${cmd.title}`.toLowerCase();
      assert.ok(
        !/mint/.test(surface),
        `no mint affordance may be contributed: ${cmd.command}`,
      );
      // The one owner-token command is the runbook LINK; anything else
      // touching owner tokens is out of bounds.
      if (/owner.?token/.test(surface)) {
        assert.strictEqual(cmd.command, "airdress.breakGlass.openRunbook");
      }
    }
  });

  test("the shipped bundle contains no code path that could mint an owner token", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const bundle = fs
      .readFileSync(
        path.join(ext.extensionPath, "dist", "extension.js"),
        "utf8",
      )
      .toLowerCase();
    // The CLI spelling of the host-shell operation, and any API-shaped
    // equivalent, must not appear in shipped code in any casing.
    for (const needle of [
      "owner-token print",
      "owner_token_print",
      "owner-tokens/mint",
      ["mint", "owner", "token"].join(""),
      "mint_owner_token",
    ]) {
      assert.ok(
        !bundle.includes(needle),
        `dist/extension.js must not contain "${needle}" — minting requires being on the operator's host`,
      );
    }
  });
});
