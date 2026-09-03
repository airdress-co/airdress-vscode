import * as assert from "assert";
import * as vscode from "vscode";
import { isJwtShaped } from "../auth/bearer";

suite("airdress-vscode scaffold", () => {
  test("extension is discoverable by its ID", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext, "extension airdress.airdress-vscode not found");
  });

  test("isJwtShaped matches the SPEC-045 predicate", () => {
    assert.strictEqual(isJwtShaped("a.b.c"), true);
    assert.strictEqual(isJwtShaped("a.b"), false);
    assert.strictEqual(isJwtShaped("a..c"), false);
    assert.strictEqual(isJwtShaped("opaque-token"), false);
  });
});
