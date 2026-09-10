import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { bundledSchemas } from "../manifests/schemas";
import { SchemaRegistry } from "../manifests/validate";
import { validateFleetText } from "../manifests/fleet";

function realRegistry(): SchemaRegistry {
  return new SchemaRegistry(bundledSchemas());
}

const FUNCTION_MANIFEST = [
  "apiVersion: airdress.co/v1alpha1",
  "kind: Function",
  "metadata:",
  "  name: relay-to-op2",
  "spec:",
  "  bundle:",
  "    path: relay.tar.zst",
  `    sha256: "${"ab".repeat(32)}"`,
  `    signer: "${"cd".repeat(32)}"`,
  "  runtime: wasm-component/v1",
  "  capabilities:",
  "    http:",
  "      hosts:",
  "        - op2.a.airdr.es",
  "  limits:",
  "    cpuDeadlineMs: 5000",
  "    memoryMib: 128",
  "    concurrency: 8",
  "  enabled: true",
].join("\n");

function extensionRoot(): string {
  const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
  assert.ok(ext);
  return ext.extensionPath;
}

suite("bundled operator-kind schemas (T6-05)", () => {
  test("every bundled schema carries an x-airdress-operator-version pin (FR-33)", () => {
    const schemas = bundledSchemas();
    assert.ok(schemas.length > 0, "at least one kind schema must ship");
    for (const { kind, schema } of schemas) {
      const pin = schema["x-airdress-operator-version"];
      assert.ok(
        typeof pin === "string" && /^v\d+\.\d+\.\d+/.test(pin),
        `schema for ${kind} must pin an operator version, got: ${String(pin)}`,
      );
    }
  });

  test("every bundled schema's $id is its published per-kind alias URL", () => {
    for (const { kind, schema } of bundledSchemas()) {
      const id = (schema as Record<string, unknown>)["$id"];
      assert.strictEqual(
        id,
        `https://schemas.airdress.co/operator/${kind}/v1.json`,
        `schema for ${kind} must carry the published alias $id`,
      );
    }
  });

  test("a grounded InferencePoolMember manifest validates", () => {
    const result = realRegistry().validateText(
      [
        "apiVersion: airdress.co/v1alpha1",
        "kind: InferencePoolMember",
        "metadata:",
        "  name: vllm-a",
        "spec:",
        "  backend: vllm-openai",
        "  url: https://inference.example.com",
        "  authSecretRef: vllm-a-token",
        "  models:",
        "    - name: gemma4",
        "      contextWindow: 8192",
        "  draining: false",
        "  transport: http-direct",
        "  traits:",
        "    supportsMultiConversation: true",
      ].join("\n"),
    );
    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(result.status, "valid");
  });

  test("an echo member without url/authSecretRef validates (serde defaults)", () => {
    const result = realRegistry().validateText(
      [
        "apiVersion: airdress.co/v1alpha1",
        "kind: InferencePoolMember",
        "metadata:",
        "  name: echo-1",
        "spec:",
        "  backend: echo",
        "  models: []",
      ].join("\n"),
    );
    assert.strictEqual(result.status, "valid");
  });

  test("deny_unknown_fields is mirrored: an unknown spec field is invalid", () => {
    const result = realRegistry().validateText(
      [
        "apiVersion: airdress.co/v1alpha1",
        "kind: InferencePoolMember",
        "metadata:",
        "  name: x",
        "spec:",
        "  backend: echo",
        "  models: []",
        "  bogusField: true",
      ].join("\n"),
    );
    assert.strictEqual(result.status, "invalid");
    assert.ok(result.issues.some((i) => i.path.startsWith("/spec")));
  });

  test("a missing required spec field is invalid", () => {
    const result = realRegistry().validateText(
      [
        "apiVersion: airdress.co/v1alpha1",
        "kind: InferencePoolMember",
        "metadata:",
        "  name: x",
        "spec:",
        "  backend: echo",
      ].join("\n"),
    );
    assert.strictEqual(result.status, "invalid");
  });

  test("a kind the extension does not know stays UNKNOWN — never valid (NFR-10)", () => {
    const result = realRegistry().validateText(
      [
        "apiVersion: airdress.co/v1alpha1",
        "kind: Zone",
        "metadata:",
        "  name: example",
        "spec: {}",
      ].join("\n"),
    );
    assert.strictEqual(result.status, "unknown-kind");
  });

  test("a grounded Function manifest validates", () => {
    const result = realRegistry().validateText(FUNCTION_MANIFEST);
    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(result.status, "valid");
  });

  test("a minimal Function (bundle path only) validates — everything else defaults", () => {
    const result = realRegistry().validateText(
      [
        "apiVersion: airdress.co/v1alpha1",
        "kind: Function",
        "metadata:",
        "  name: hello",
        "spec:",
        "  bundle:",
        "    path: hello.tar.zst",
      ].join("\n"),
    );
    assert.strictEqual(result.status, "valid");
  });

  test("Function: an unknown spec field is invalid (deny_unknown_fields mirrored)", () => {
    const result = realRegistry().validateText(
      FUNCTION_MANIFEST + "\n  bogusField: true",
    );
    assert.strictEqual(result.status, "invalid");
    assert.ok(result.issues.some((i) => i.path.startsWith("/spec")));
  });

  test("Function: a bundle path with a directory separator or `..` is invalid", () => {
    for (const bad of ["../escape.tar.zst", "dir/relay.tar.zst", ".."]) {
      const result = realRegistry().validateText(
        FUNCTION_MANIFEST.replace("path: relay.tar.zst", `path: "${bad}"`),
      );
      assert.strictEqual(result.status, "invalid", bad);
      assert.ok(
        result.issues.some((i) => i.path === "/spec/bundle/path"),
        `${bad} must be rejected at spec.bundle.path`,
      );
    }
  });

  test("Function: a wildcard http host is invalid", () => {
    const wildcard = realRegistry().validateText(
      FUNCTION_MANIFEST.replace("- op2.a.airdr.es", '- "*.airdr.es"'),
    );
    assert.strictEqual(wildcard.status, "invalid");
    assert.ok(
      wildcard.issues.some((i) =>
        i.path.startsWith("/spec/capabilities/http/hosts"),
      ),
    );
  });

  test("Function: runtime is not gated by the schema — the operator refuses an unknown tier at apply time", () => {
    // The published schema types `runtime` as a plain string (its
    // description says only `wasm-component/v1` is served, but the
    // enum lives on the operator, not the manifest schema). So a
    // second tier name validates here and is refused later on apply —
    // the hand-seeded schema wrongly encoded the enum in the schema.
    const runtime = realRegistry().validateText(
      FUNCTION_MANIFEST.replace(
        "runtime: wasm-component/v1",
        "runtime: native/v1",
      ),
    );
    assert.strictEqual(runtime.status, "valid");
  });

  test("Function: a limit outside the schema's range and a missing bundle are invalid", () => {
    const limit = realRegistry().validateText(
      FUNCTION_MANIFEST.replace("memoryMib: 128", "memoryMib: 8"),
    );
    assert.strictEqual(limit.status, "invalid");
    const noBundle = realRegistry().validateText(
      [
        "apiVersion: airdress.co/v1alpha1",
        "kind: Function",
        "metadata:",
        "  name: hello",
        "spec:",
        "  enabled: true",
      ].join("\n"),
    );
    assert.strictEqual(noBundle.status, "invalid");
  });

  for (const kind of ["inference-pool-member", "function"]) {
    test(`${kind}: the bundled copy and the editor-association copy are byte-identical`, () => {
      const root = extensionRoot();
      const bundled = fs.readFileSync(
        path.join(root, `src/manifests/schemas/${kind}.json`),
        "utf8",
      );
      const association = fs.readFileSync(
        path.join(root, `schemas/${kind}.schema.json`),
        "utf8",
      );
      assert.strictEqual(bundled, association);
    });
  }

  test("the envelope schema routes every bundled kind to its per-kind file", () => {
    const envelope = JSON.parse(
      fs.readFileSync(
        path.join(extensionRoot(), "schemas/operator-manifest.schema.json"),
        "utf8",
      ),
    ) as {
      allOf: Array<{
        if: { properties: { kind: { const: string } } };
        then: { $ref: string };
      }>;
    };
    const routed = new Map(
      envelope.allOf.map((b) => [b.if.properties.kind.const, b.then.$ref]),
    );
    for (const { kind } of bundledSchemas()) {
      const ref = routed.get(kind);
      assert.ok(ref, `envelope schema must route kind ${kind}`);
      assert.ok(
        fs.existsSync(path.join(extensionRoot(), "schemas", ref)),
        `${ref} must exist`,
      );
    }
  });
});

suite("fleet TOML family (T6-05, design §5.4)", () => {
  const validFleet = [
    'operator_id = "019e2b8c-2474-7671-a5da-6786ec715fd3"',
    'operator_name = "sample-operator-01"',
    'operator_fqdn = "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es"',
    'operator_version = "v0.1.9-alpha.5"',
    'host_id = "ax-fsn-01"',
    'ipv6_addr = "2a01:4f8:c012:abcd::10"',
    "tap_index = 0",
    "ram_mb = 256",
    "vcpus = 1",
    "cpu_shares = 128",
    "data_volume_gb = 10",
    "operator_port = 443",
    "dns_enabled = true",
  ].join("\n");

  test("a sample-shaped fleet manifest validates", () => {
    const result = validateFleetText(validFleet);
    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(result.status, "valid");
  });

  test("a missing required field is invalid", () => {
    const withoutId = validFleet
      .split("\n")
      .filter((l) => !l.startsWith("operator_id"))
      .join("\n");
    const result = validateFleetText(withoutId);
    assert.strictEqual(result.status, "invalid");
  });

  test("a raw-IP operator_fqdn is invalid", () => {
    const tampered = validFleet.replace(
      /operator_fqdn = ".*"/,
      'operator_fqdn = "185.43.32.11"',
    );
    assert.strictEqual(validateFleetText(tampered).status, "invalid");
  });

  test("TOML syntax errors are parse errors", () => {
    assert.strictEqual(
      validateFleetText("operator_id = [unclosed").status,
      "parse-error",
    );
  });

  test("the fleet schema is version-pinned and marked validate-only", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(extensionRoot(), "schemas/fleet-manifest.schema.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.match(String(schema["x-airdress-operator-version"]), /^v\d+/);
    assert.match(String(schema.description), /VALIDATE-ONLY/);
  });

  test("NO apply affordance exists for the TOML family", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(extensionRoot(), "package.json"), "utf8"),
    ) as {
      contributes: {
        commands: Array<{
          command: string;
          title: string;
          enablement?: string;
        }>;
      };
    };
    const commands = pkg.contributes.commands;
    // Every apply-ish command is scoped away from TOML editors…
    for (const cmd of commands) {
      if (/apply/i.test(cmd.command) || /apply/i.test(cmd.title)) {
        assert.ok(
          cmd.enablement,
          `${cmd.command} must carry an enablement clause`,
        );
        assert.ok(
          !/toml/i.test(cmd.enablement) &&
            /editorLangId == yaml/.test(cmd.enablement),
          `${cmd.command} must be enabled only for yaml/json editors`,
        );
      }
      // …and no command targets the fleet family at all.
      assert.ok(
        !/fleet/i.test(cmd.command) && !/fleet/i.test(cmd.title),
        "no command may exist for fleet manifests — validate-only (FR-32)",
      );
    }
  });
});
