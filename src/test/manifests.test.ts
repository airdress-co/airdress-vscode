import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ApiError, baseUrlFor, parseProblem } from "../api/client";
import { parseManifest, SchemaRegistry } from "../manifests/validate";
import { AIRDRESS_SCHEME, LiveManifestProvider } from "../manifests/virtual";
import { problemToDiagnostic } from "../manifests/apply";

const TEST_SCHEMA = {
  $id: "https://airdress.co/schemas/operator/testkind.v1.json",
  "x-airdress-operator-version": "v0.0.0-test",
  type: "object",
  required: ["apiVersion", "kind", "metadata", "spec"],
  properties: {
    apiVersion: { const: "airdress.co/v1alpha1" },
    kind: { const: "TestKind" },
    metadata: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    },
    spec: {
      type: "object",
      required: ["backend"],
      properties: { backend: { type: "string" } },
      additionalProperties: false,
    },
  },
};

function registry(): SchemaRegistry {
  return new SchemaRegistry([{ kind: "TestKind", schema: TEST_SCHEMA }]);
}

suite("manifest parsing (T6-04)", () => {
  test("parses a YAML envelope", () => {
    const parsed = parseManifest(
      "apiVersion: airdress.co/v1alpha1\nkind: TestKind\nmetadata:\n  name: a\nspec: {}\n",
    );
    assert.ok("envelope" in parsed);
    assert.strictEqual(parsed.envelope.kind, "TestKind");
    assert.strictEqual(parsed.envelope.metadata.name, "a");
  });

  test("parses a JSON envelope (JSON is YAML)", () => {
    const parsed = parseManifest(
      JSON.stringify({
        apiVersion: "airdress.co/v1alpha1",
        kind: "TestKind",
        metadata: { name: "a" },
        spec: {},
      }),
    );
    assert.ok("envelope" in parsed);
  });

  test("reports missing kind / apiVersion / metadata.name", () => {
    for (const [text, message] of [
      ["apiVersion: v1\nmetadata: {name: a}\n", /kind/],
      ["kind: X\nmetadata: {name: a}\n", /apiVersion/],
      ["kind: X\napiVersion: v1\n", /metadata\.name/],
    ] as const) {
      const parsed = parseManifest(text);
      assert.ok("error" in parsed);
      assert.match(parsed.error, message);
    }
  });

  test("reports YAML syntax errors as parse errors", () => {
    const result = registry().validateText("kind: [unclosed\n");
    assert.strictEqual(result.status, "parse-error");
    assert.ok(result.issues.length > 0);
  });
});

suite("bundled Ajv validation (T6-04)", () => {
  const valid =
    "apiVersion: airdress.co/v1alpha1\nkind: TestKind\nmetadata:\n  name: a\nspec:\n  backend: echo\n";

  test("a valid manifest validates", () => {
    assert.strictEqual(registry().validateText(valid).status, "valid");
  });

  test("an invalid manifest reports issue paths", () => {
    const result = registry().validateText(
      "apiVersion: airdress.co/v1alpha1\nkind: TestKind\nmetadata:\n  name: a\nspec:\n  bogus: 1\n",
    );
    assert.strictEqual(result.status, "invalid");
    assert.ok(result.issues.some((i) => i.path.startsWith("/spec")));
  });

  test("an unknown kind is UNKNOWN — never valid (NFR-10)", () => {
    const result = registry().validateText(
      "apiVersion: airdress.co/v1alpha1\nkind: MysteryKind\nmetadata:\n  name: a\nspec: {}\n",
    );
    assert.strictEqual(result.status, "unknown-kind");
    assert.notStrictEqual(result.status, "valid");
    assert.match(result.issues[0].message, /validation is disabled/);
  });

  test("schemas expose their operator-version pin (FR-33)", () => {
    assert.strictEqual(registry().versionPin("TestKind"), "v0.0.0-test");
  });
});

suite("RFC 7807 Problem surfacing (T6-04)", () => {
  test("parseProblem extracts title/detail defensively", () => {
    const p = parseProblem(
      {
        type: "https://x/err",
        title: "Invalid manifest",
        detail: "spec.backend unknown",
      },
      422,
    );
    assert.strictEqual(p.title, "Invalid manifest");
    assert.strictEqual(p.detail, "spec.backend unknown");
    assert.deepStrictEqual(parseProblem("not json", 500), { status: 500 });
  });

  test("the operator's title and detail land VERBATIM in the diagnostic", () => {
    const diagnostic = problemToDiagnostic(
      new ApiError(
        {
          title: "Invalid manifest",
          detail: "spec.backend unknown",
          type: "https://x/err",
        },
        422,
      ),
    );
    assert.strictEqual(
      diagnostic.message,
      "Invalid manifest — spec.backend unknown",
    );
    assert.strictEqual(diagnostic.source, "airdress-operator");
    assert.strictEqual(diagnostic.severity, vscode.DiagnosticSeverity.Error);
  });
});

suite("virtual documents (T6-04)", () => {
  test("published content round-trips at an airdress: URI", () => {
    const provider = new LiveManifestProvider();
    const uri = provider.publish("p1", "TestKind", "a", "kind: TestKind\n");
    assert.strictEqual(uri.scheme, AIRDRESS_SCHEME);
    assert.strictEqual(uri.authority, "p1");
    assert.strictEqual(
      provider.provideTextDocumentContent(uri),
      "kind: TestKind\n",
    );
  });

  test("opening a virtual doc writes nothing to disk and is read-only", async () => {
    const provider = new LiveManifestProvider();
    // Register under a test-only scheme: the extension host already has
    // the real provider on `airdress:`.
    const disposable = vscode.workspace.registerTextDocumentContentProvider(
      "airdress-test",
      provider,
    );
    try {
      const uri = provider
        .publish("p1", "TestKind", "a", "kind: TestKind\n")
        .with({ scheme: "airdress-test" });
      const doc = await vscode.workspace.openTextDocument(uri);
      assert.strictEqual(doc.getText(), "kind: TestKind\n");
      assert.strictEqual(doc.isDirty, false);
      // A content-provider document has no fsPath that exists on disk.
      assert.ok(!fs.existsSync(doc.uri.fsPath));
      // And no file system provider is registered for the scheme, so
      // there is no write/save path at all: saving must fail.
      assert.strictEqual(await doc.save(), false);
      assert.ok(!fs.existsSync(doc.uri.fsPath));
    } finally {
      disposable.dispose();
    }
  });
});

suite("no save-to-apply path (T6-04, design §5.2)", () => {
  test("the shipped bundle registers no save listener at all", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const bundle = fs.readFileSync(
      path.join(ext.extensionPath, "dist", "extension.js"),
      "utf8",
    );
    for (const forbidden of [
      "onDidSaveTextDocument",
      "onWillSaveTextDocument",
      "onDidSaveNotebookDocument",
    ]) {
      assert.ok(
        !bundle.includes(forbidden),
        `dist/extension.js must not reference ${forbidden} — ` +
          "there must be NO code path from a save event to an apply",
      );
    }
  });
});

suite("base URL derivation (T6-04)", () => {
  test("airdress FQDNs go over HTTPS; dev localhost over local HTTP", () => {
    assert.strictEqual(
      baseUrlFor({
        id: "p",
        label: "ada",
        fqdn: "ada.a.airdr.es",
        authMode: "zitadel",
        dev: false,
      }),
      "https://ada.a.airdr.es",
    );
    assert.strictEqual(
      baseUrlFor({
        id: "p",
        label: "dev",
        fqdn: "localhost",
        authMode: "bearer",
        dev: true,
      }),
      "http://127.0.0.1:8080",
    );
  });
});
