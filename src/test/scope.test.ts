import * as assert from "assert";
import * as vscode from "vscode";
import { applyConfirmation, planApplyDocuments } from "../manifests/scope";
import { validateCommand } from "../manifests/apply";
import type { Profile } from "../profiles/model";

const PROFILE: Profile = {
  id: "p1",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

const DOC_A =
  "apiVersion: airdress.co/v1alpha1\nkind: Zone\nmetadata:\n  name: a\nspec: {}\n";
const DOC_B =
  "apiVersion: airdress.co/v1alpha1\nkind: Zone\nmetadata:\n  name: b\nspec: {}\n";

suite("scoped apply planning", () => {
  test("a single-document file keeps its ORIGINAL text byte-for-byte", () => {
    const plan = planApplyDocuments(DOC_A, "yaml");
    assert.ok("docs" in plan);
    assert.strictEqual(plan.docs.length, 1);
    assert.strictEqual(plan.docs[0].text, DOC_A);
    assert.strictEqual(plan.docs[0].kind, "Zone");
    assert.strictEqual(plan.docs[0].name, "a");
  });

  test("a multi-document file splits into one apply-ready doc per resource", () => {
    const plan = planApplyDocuments(`${DOC_A}---\n${DOC_B}`, "yaml");
    assert.ok("docs" in plan);
    assert.deepStrictEqual(
      plan.docs.map((d) => `${d.kind}/${d.name}`),
      ["Zone/a", "Zone/b"],
    );
    // Each split document must be independently parseable and carry
    // its own envelope — it is POSTed on its own.
    for (const doc of plan.docs) {
      const replan = planApplyDocuments(doc.text, "yaml");
      assert.ok("docs" in replan);
      assert.strictEqual(replan.docs.length, 1);
    }
  });

  test("one malformed document fails the WHOLE plan — no partial apply of a broken file", () => {
    const plan = planApplyDocuments(
      `${DOC_A}---\nkind: Zone\nspec: {}\n`,
      "yaml",
    );
    assert.ok("error" in plan);
    assert.match(plan.error, /Document 2 of 2/);
  });

  test("JSON is always a single document", () => {
    const json = JSON.stringify({
      apiVersion: "airdress.co/v1alpha1",
      kind: "Zone",
      metadata: { name: "a" },
      spec: {},
    });
    const plan = planApplyDocuments(json, "json");
    assert.ok("docs" in plan);
    assert.strictEqual(plan.docs[0].text, json);
  });

  test("an empty file is an error, not an empty apply", () => {
    const plan = planApplyDocuments("\n# nothing\n", "yaml");
    assert.ok("error" in plan);
  });
});

suite("apply confirmation wording", () => {
  test("a single resource names kind/name AND the profile + FQDN", () => {
    const plan = planApplyDocuments(DOC_A, "yaml");
    assert.ok("docs" in plan);
    const { message } = applyConfirmation(plan.docs, PROFILE);
    assert.match(message, /Zone\/a/);
    assert.match(message, /"ada"/);
    assert.match(message, /ada\.a\.airdr\.es/);
  });

  test("a subset names EVERY selected resource and the FQDN", () => {
    const plan = planApplyDocuments(`${DOC_A}---\n${DOC_B}`, "yaml");
    assert.ok("docs" in plan);
    const { message, detail } = applyConfirmation(plan.docs, PROFILE);
    assert.match(message, /2 resources/);
    assert.match(message, /ada\.a\.airdr\.es/);
    assert.match(String(detail), /Zone\/a/);
    assert.match(String(detail), /Zone\/b/);
  });
});

suite("validate is distinct from apply", () => {
  test("the validate command issues NO network request of any kind", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "yaml",
      content:
        "apiVersion: airdress.co/v1alpha1\nkind: InferencePoolMember\nmetadata:\n  name: x\nspec:\n  bogus: 1\n",
    });
    await vscode.window.showTextDocument(doc);
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetches += 1;
      return realFetch(...args);
    }) as typeof fetch;
    try {
      await validateCommand();
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.strictEqual(
      fetches,
      0,
      "validate must not talk to anything — mutating or otherwise",
    );
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);
    assert.ok(
      diagnostics.some((d) => d.source === "airdress"),
      "validate produces diagnostics",
    );
  });

  test("validate reports every document of a multi-document file", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "yaml",
      content:
        "apiVersion: airdress.co/v1alpha1\nkind: InferencePoolMember\nmetadata:\n  name: ok\nspec: {}\n" +
        "---\napiVersion: airdress.co/v1alpha1\nkind: InferencePoolMember\nmetadata:\n  name: bad\nspec:\n  bogus: 1\n",
    });
    await vscode.window.showTextDocument(doc);
    await validateCommand();
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);
    assert.ok(diagnostics.length > 0, "the second document's issue surfaces");
    // The issue is anchored on the SECOND document, not line 0.
    assert.ok(
      diagnostics.some((d) => d.range.start.line > 0),
      "diagnostics point into the offending document",
    );
  });
});
