import * as assert from "assert";
import {
  bindIdentityPrompt,
  conflictMessage,
  createSubUserConfirm,
  deleteResourceConfirm,
  deleteResourcePrompt,
  namesTarget,
  revokeSubUserTitle,
  targetPhrase,
} from "../profiles/confirm";
import { applyConfirmation } from "../manifests/scope";

/**
 * With the profile pick gone from in front of commands, the confirm is
 * the only place a write's target is read. Every prompt that stands in
 * front of a write must name it by label AND FQDN — checked here, per
 * wording, so a rewrite that drops one fails a test rather than a user.
 */
const PROFILE = {
  label: "ada",
  fqdn: "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es",
};

suite("every write-guarding prompt names its target", () => {
  test("the target phrase carries label and FQDN", () => {
    assert.strictEqual(
      targetPhrase(PROFILE),
      'profile "ada" (019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es)',
    );
  });

  const cases: Array<[string, string]> = [
    [
      "apply (one)",
      applyConfirmation(
        [{ kind: "Schedule", name: "nightly", text: "", body: "", offset: 0 }],
        { ...PROFILE, id: "p", authMode: "zitadel", dev: false },
      ).message,
    ],
    [
      "apply (many)",
      applyConfirmation(
        [
          { kind: "Schedule", name: "a", text: "", body: "", offset: 0 },
          { kind: "Function", name: "b", text: "", body: "", offset: 0 },
        ],
        { ...PROFILE, id: "p", authMode: "zitadel", dev: false },
      ).message,
    ],
    ["panel delete", deleteResourceConfirm("Schedule", "nightly", PROFILE)],
    [
      "row delete (type-to-confirm)",
      deleteResourcePrompt("Schedule", "nightly", PROFILE),
    ],
    [
      "409 prompt (overwrite is a write)",
      conflictMessage("Schedule", "nightly", PROFILE),
    ],
    ["create sub-user", createSubUserConfirm("bob", PROFILE)],
    ["revoke sub-user (title)", revokeSubUserTitle("bob", PROFILE)],
    [
      "attach identity",
      bindIdentityPrompt("https://issuer.test", "bob", PROFILE),
    ],
  ];
  for (const [what, text] of cases) {
    test(`${what} names the target`, () => {
      assert.ok(namesTarget(text, PROFILE), text);
      assert.ok(text.includes("ada"), "label");
      assert.ok(text.includes(PROFILE.fqdn), "fqdn");
    });
  }

  test("namesTarget is strict about the pairing, not just the words", () => {
    assert.ok(
      !namesTarget(
        "ada on 019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es",
        PROFILE,
      ),
    );
  });
});
