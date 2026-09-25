import * as assert from "assert";
import {
  bindIdentityPrompt,
  conflictMessage,
  createSubUserConfirm,
  deployCreateConfirm,
  deployReplaceConfirm,
  deleteResourceConfirm,
  deleteResourcePrompt,
  namesTarget,
  publishSourceConfirm,
  publishTemplateConfirm,
  rebaseSourceConfirm,
  revokeEnrollmentConfirm,
  revokeSubUserTitle,
  signerSetConfirm,
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
      "revoke enrollment",
      revokeEnrollmentConfirm(
        { id: "e1", deviceLabel: "dead phone", airdress: "ada.a.airdr.es" },
        PROFILE,
      ),
    ],
    [
      "attach identity",
      bindIdentityPrompt("https://issuer.test", "bob", PROFILE),
    ],
    ["publish function source", publishSourceConfirm("relay", PROFILE)],
    [
      "rebase function source",
      rebaseSourceConfirm("relay", "sha256:ab", PROFILE),
    ],
    ["publish a template", publishTemplateConfirm("Hello", "hello", PROFILE)],
    [
      "deploy (replace)",
      deployReplaceConfirm(
        {
          name: "relay",
          replacing: "sha256:1a",
          version: "sha256:9f",
          files: 3,
          unreached: 1,
          signer: "key 5c1e…a07b (this workstation)",
        },
        PROFILE,
      ).message,
    ],
    [
      "deploy (create)",
      deployCreateConfirm(
        {
          name: "relay",
          version: "sha256:9f",
          files: 3,
          signers: "key 5c1e…a07b",
          grantYaml: "spec:\n  capabilities:\n    log: {}\n",
          configValues: 0,
          secretValues: 0,
        },
        PROFILE,
      ).message,
    ],
    [
      "change the signer set",
      signerSetConfirm(
        { name: "relay", change: "Allow machine ci to sign", resulting: [] },
        PROFILE,
      ).message,
    ],
  ];
  for (const [what, text] of cases) {
    test(`${what} names the target`, () => {
      assert.ok(namesTarget(text, PROFILE), text);
      assert.ok(text.includes("ada"), "label");
      assert.ok(text.includes(PROFILE.fqdn), "fqdn");
    });
  }

  test("the deploy prompts carry what the person is agreeing to", () => {
    const replace = deployReplaceConfirm(
      {
        name: "relay",
        replacing: "sha256:1a",
        replacingNote: "signed by machine ci",
        version: "sha256:9f",
        files: 3,
        unreached: 1,
        signer: "key 5c1e…a07b (this workstation)",
      },
      PROFILE,
    ).detail;
    assert.match(replace, /replace {2}sha256:1a {2}\(signed by machine ci\)/);
    assert.match(
      replace,
      /with {5}sha256:9f {2}\(3 files; 1 not reached by an import\)/,
    );
    assert.match(replace, /The grant does not change\./);
    const create = deployCreateConfirm(
      {
        name: "relay",
        template: "webhook-relay",
        version: "sha256:9f",
        files: 3,
        signers: "key 5c1e…a07b (this workstation)",
        grantYaml: "spec:\n  capabilities:\n    log: {}\n",
        configValues: 2,
        secretValues: 1,
      },
      PROFILE,
    );
    assert.match(create.message, /from template "webhook-relay"/);
    assert.match(
      create.detail,
      /It will be allowed to:\n {2}spec:\n {4}capabilities:\n {6}log: \{\}/,
    );
    assert.match(create.detail, /Config: 2 values \(1 read from secrets\)/);
    const set = signerSetConfirm(
      {
        name: "relay",
        change: "Remove key 5c1e…a07b as a signer",
        resulting: ["machine ci"],
        warning: "key 5c1e…a07b signed the version relay runs now",
      },
      PROFILE,
    ).detail;
    assert.match(set, /^key 5c1e…a07b signed the version/);
    assert.match(set, /Allowed to sign afterwards:\n {2}- machine ci/);
  });

  test("namesTarget is strict about the pairing, not just the words", () => {
    assert.ok(
      !namesTarget(
        "ada on 019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es",
        PROFILE,
      ),
    );
  });
});
