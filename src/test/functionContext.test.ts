import * as assert from "assert";
import Ajv2020 from "ajv/dist/2020";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  driftOf,
  logLineText,
  mapEntriesFor,
  operatorHost,
  resolveFunctionContext,
  statusText,
  type FsLike,
  type FunctionContext,
  type LiveState,
} from "../functions/context";
import {
  rangeOfPath,
  sameFiles,
  schemaDiagnostics,
  versionLensTitle,
  withSignerSet,
} from "../functions/contextUi";

/** A file system held in a map, by POSIX path. */
function fakeFs(files: Record<string, string>): FsLike & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readText: async (p) => {
      reads.push(p);
      return files[p];
    },
  };
}

const SOURCE_JSON = JSON.stringify({
  apiVersion: "airdress.function/v1",
  id: "local.hello",
  runtime: "js-source/v1",
  entry: "src/main.ts",
});

const MANIFEST = `apiVersion: airdress.co/v1alpha1
kind: Function
metadata:
  name: e2e-hello
spec:
  capabilities:
    log: {}
  source:
    # who may sign
    signers:
      - key: 95ad
      - machine: d4b6
    version: sha256:aaaa
`;

suite("Function context: which function a file belongs to", () => {
  test("a file under src/ belongs to the folder with a source function.json, named by function.yaml", async () => {
    const f = fakeFs({
      "/ws/functions/hello/function.json": SOURCE_JSON,
      "/ws/functions/hello/function.yaml": MANIFEST,
    });
    const ctx = await resolveFunctionContext(
      f,
      "/ws/functions/hello/src/lib/util.ts",
      "/ws",
    );
    assert.ok(ctx);
    assert.strictEqual(ctx.root, "/ws/functions/hello");
    assert.strictEqual(ctx.name, "e2e-hello");
    assert.strictEqual(ctx.nameFrom, "manifest");
    assert.strictEqual(ctx.entry, "src/main.ts");
    assert.strictEqual(ctx.committedVersion, "sha256:aaaa");
    assert.strictEqual(ctx.signerCount, 2);
    assert.strictEqual(ctx.basedOn, "sha256:aaaa");
    assert.strictEqual(ctx.manifestPath, "/ws/functions/hello/function.yaml");
    assert.strictEqual(ctx.operator, undefined);
  });

  test("a function.json that is not a source function is not ours (Azure Functions uses the name too)", async () => {
    const f = fakeFs({
      "/ws/api/function.json": JSON.stringify({ bindings: [] }),
    });
    assert.strictEqual(
      await resolveFunctionContext(f, "/ws/api/index.js", "/ws"),
      undefined,
    );
  });

  test("nothing above the workspace folder is read", async () => {
    const f = fakeFs({ "/function.json": SOURCE_JSON });
    assert.strictEqual(
      await resolveFunctionContext(f, "/ws/a/b.ts", "/ws"),
      undefined,
    );
    assert.ok(
      f.reads.every((p) => p.startsWith("/ws/")),
      `read outside the workspace: ${f.reads.join(", ")}`,
    );
    assert.strictEqual(
      await resolveFunctionContext(f, "/elsewhere/x.ts", "/ws"),
      undefined,
    );
  });

  test("the map file names the manifest and the operator", async () => {
    const f = fakeFs({
      "/ws/airdress.functions.yaml": `layout: 1
operator: https://prod.example.a.airdr.es/
functions:
  - path: functions/digest
    manifest: deploy/prod/digest.yaml
  - path: ./functions/digest/
    manifest: deploy/staging/digest.yaml
    operator: staging.example
`,
      "/ws/functions/digest/function.json": SOURCE_JSON,
      "/ws/deploy/prod/digest.yaml": MANIFEST.replace("e2e-hello", "digest"),
    });
    const ctx = await resolveFunctionContext(
      f,
      "/ws/functions/digest/src/main.ts",
      "/ws",
    );
    assert.ok(ctx);
    assert.strictEqual(ctx.name, "digest");
    assert.strictEqual(ctx.manifestPath, "/ws/deploy/prod/digest.yaml");
    assert.strictEqual(ctx.operator, "prod.example.a.airdr.es");
    assert.strictEqual(ctx.operatorFrom, "map");
    assert.strictEqual(ctx.mapDeployments, 2);
  });

  test("a checkout record names the operator and the base; the folder names a function with nothing else", async () => {
    const f = fakeFs({
      "/ws/relay/function.json": SOURCE_JSON,
      "/ws/relay/.airdress-function.json": JSON.stringify({
        operator: "op.example",
        function: "relay-to-op2",
        basedOn: "sha256:bbbb",
      }),
      "/ws/bare/function.json": SOURCE_JSON,
    });
    const relay = await resolveFunctionContext(
      f,
      "/ws/relay/function.json",
      "/ws",
    );
    assert.ok(relay);
    assert.strictEqual(relay.name, "relay-to-op2");
    assert.strictEqual(relay.nameFrom, "checkout");
    assert.strictEqual(relay.operator, "op.example");
    assert.strictEqual(relay.basedOn, "sha256:bbbb");
    const bare = await resolveFunctionContext(f, "/ws/bare/src/x.ts", "/ws");
    assert.ok(bare);
    assert.strictEqual(bare.name, "bare");
    assert.strictEqual(bare.nameFrom, "folder");
    assert.strictEqual(bare.basedOn, null);
    assert.strictEqual(bare.manifestPath, undefined);
  });

  test("map entries and operator hosts are normalised", () => {
    assert.deepStrictEqual(mapEntriesFor("functions:\n  - path: .\n", "."), [
      { manifest: "function.yaml", operator: undefined },
    ]);
    assert.strictEqual(
      operatorHost("HTTPS://Op.Example:443/x"),
      "op.example:443",
    );
    assert.strictEqual(operatorHost("op.example"), "op.example");
  });
});

suite("Function context: what the editor shows", () => {
  const ctx: FunctionContext = {
    root: "/ws/f",
    name: "f",
    nameFrom: "manifest",
    committedVersion: "sha256:aaaaaaaaaaaaaaaa",
    manifestPath: "/ws/f/function.yaml",
    basedOn: "sha256:aaaaaaaaaaaaaaaa",
  };
  const loaded = { status: "True", reason: "SourceAdmitted" };

  test("git's version running is in step; another version is named", () => {
    const inStep: LiveState = {
      kind: "live",
      operator: "op",
      serving: "sha256:aaaaaaaaaaaaaaaa",
      loaded,
      localMatchesServing: true,
    };
    assert.strictEqual(driftOf(ctx, inStep), "in-step");
    assert.match(statusText(ctx, inStep).text, /\$\(pass\) aaaaaaaaaaaa$/);
    assert.strictEqual(versionLensTitle(ctx, inStep), "$(pass) serving on op");

    const moved: LiveState = { ...inStep, serving: "sha256:bbbbbbbbbbbbbbbb" };
    assert.strictEqual(driftOf(ctx, moved), "git-behind");
    const shown = statusText(ctx, moved);
    assert.ok(shown.warn);
    assert.match(shown.tooltip, /bring it into git/);
    assert.strictEqual(
      versionLensTitle(ctx, moved),
      "$(warning) op runs bbbbbbbbbbbb — not this",
    );
  });

  test("a version that does not load says why, and edits on disk are marked", () => {
    const shown = statusText(ctx, {
      kind: "live",
      operator: "op",
      serving: "sha256:aaaaaaaaaaaaaaaa",
      loaded: { status: "False", reason: "SourceSignerMismatch" },
      ready: { status: "True", reason: "ServingPrevious" },
      localMatchesServing: false,
    });
    assert.ok(shown.warn);
    assert.match(shown.text, /\$\(error\).*\$\(pencil\)$/);
    assert.match(shown.tooltip, /Not loaded: SourceSignerMismatch/);
    assert.match(shown.tooltip, /Ready: ServingPrevious/);
    assert.match(shown.tooltip, /differ from what runs/);
  });

  test("absent, unreachable and no profile are said, never guessed", () => {
    assert.match(
      statusText(ctx, { kind: "absent", operator: "op" }).text,
      /not deployed/,
    );
    assert.ok(statusText(ctx, { kind: "unreachable", operator: "op" }).warn);
    assert.match(
      versionLensTitle(ctx, { kind: "no-profile" }),
      /no signed-in profile/,
    );
  });

  test("the log is one line per row, oldest-first ordering left to the caller", () => {
    assert.strictEqual(
      logLineText({
        at: "2026-09-25T18:00:00Z",
        level: "info",
        kind: "log",
        invocation: "0123456789",
        body: { message: "answered GET /" },
      }),
      "2026-09-25T18:00:00Z info  log          01234567 answered GET /",
    );
  });

  test("a tree is the served version only file for file", () => {
    const tree = new Map([["src/main.ts", Buffer.from("x")]]);
    const x =
      "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
    assert.ok(sameFiles(tree, [{ path: "src/main.ts", sha256: x }]));
    assert.ok(!sameFiles(tree, [{ path: "src/main.ts", sha256: "00" }]));
    assert.ok(
      !sameFiles(tree, [
        { path: "src/main.ts", sha256: x },
        { path: "function.json", sha256: x },
      ]),
    );
  });

  test("lenses land on spec.source.version and the signers key", () => {
    const version = rangeOfPath(MANIFEST, ["spec", "source", "version"]);
    assert.strictEqual(version.start.line, 12);
    const signers = rangeOfPath(MANIFEST, ["spec", "source", "signers"], true);
    assert.strictEqual(signers.start.line, 9);
  });
});

suite("Function context: committed signer set", () => {
  test("the set replaces a single signer and keeps the rest of the file", () => {
    const single = MANIFEST.replace(
      "    signers:\n      - key: 95ad\n      - machine: d4b6\n",
      "    signer: 95ad\n",
    );
    const next = withSignerSet(single, "e2e-hello", [
      { key: "95ad" },
      { machine: "d4b6" },
    ]);
    assert.ok(next);
    assert.match(next, /# who may sign/);
    assert.match(next, /signers:\n\s+- key: 95ad\n\s+- machine: d4b6/);
    assert.doesNotMatch(next, /signer: 95ad/);
    assert.match(next, /version: sha256:aaaa/);
  });

  test("another function's manifest, or one with no source, is left alone", () => {
    assert.strictEqual(withSignerSet(MANIFEST, "other", []), undefined);
    assert.strictEqual(
      withSignerSet(
        "kind: Function\nmetadata:\n  name: x\nspec: {}\n",
        "x",
        [],
      ),
      undefined,
    );
  });
});

suite("Function context: schemas an author edits by hand", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

  test("the vendored schemas and their bundled twins are byte-identical", () => {
    assert.strictEqual(
      read("schemas/function-source.schema.json"),
      read("src/functions/schemas/function-source.json"),
    );
    assert.strictEqual(
      read("schemas/functions-layout.schema.json"),
      read("src/functions/schemas/functions-layout.json"),
    );
  });

  test("an id without a dot is placed on the id, in words an author can act on", () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      JSON.parse(read("schemas/function-source.schema.json")) as object,
    );
    const text = `{
  "apiVersion": "airdress.function/v1",
  "id": "e2e-hello",
  "name": "Hello",
  "version": "0.1.0",
  "entry": "src/main.ts",
  "runtime": "js-source/v1",
  "minHost": "airdress.function-host/1.0",
  "capabilities": [{ "name": "airdress:fn/log@0.1.0", "hosts": ["x"] }],
  "triggers": [{ "type": "http", "path": "/" }]
}`;
    const found = schemaDiagnostics(validate, text, "json");
    const id = found.find((d) => /reverse-DNS/.test(d.message));
    assert.ok(id, found.map((d) => d.message).join("\n"));
    assert.strictEqual(id.range.start.line, 2);
    const hosts = found.find((d) => /hosts is not a field/.test(d.message));
    assert.ok(hosts, found.map((d) => d.message).join("\n"));
    assert.strictEqual(hosts.range.start.line, 8);
    assert.strictEqual(hosts.severity, vscode.DiagnosticSeverity.Error);
  });
});

suite("Function context: contributions", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  ) as {
    activationEvents: string[];
    contributes: {
      menus: Record<
        string,
        Array<{ command: string; when?: string; group?: string }>
      >;
      configuration: { properties: Record<string, { default?: unknown }> };
      yamlValidation: Array<{ fileMatch: string; url: string }>;
    };
  };

  test("the editor title carries Deploy and Validate only inside a function", () => {
    const title = pkg.contributes.menus["editor/title"];
    for (const cmd of [
      "airdress.functions.deploy",
      "airdress.functions.source.validate",
    ]) {
      const item = title.find((m) => m.command === cmd);
      assert.ok(item, cmd);
      assert.match(item.when ?? "", /airdress\.inFunction/);
      assert.match(item.group ?? "", /^navigation/);
    }
    for (const m of title) {
      assert.match(m.when ?? "", /airdress\.inFunction/, m.command);
    }
  });

  test("validate on save is a setting, on by default; the map file has a schema", () => {
    assert.strictEqual(
      pkg.contributes.configuration.properties[
        "airdress.functions.validateOnSave"
      ]?.default,
      true,
    );
    assert.ok(
      pkg.contributes.yamlValidation.some(
        (v) => v.fileMatch === "airdress.functions.yaml",
      ),
    );
    assert.ok(
      pkg.activationEvents.includes("workspaceContains:**/function.json"),
    );
  });
});
