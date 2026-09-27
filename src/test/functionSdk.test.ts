import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ApiClient } from "../api/client";
import {
  DIAGNOSTIC_SOURCE,
  noteDiagnostics,
  refusalDiagnostics,
} from "../functions/diagnostics";
import {
  applyFix,
  FIXABLE_SDK_REFUSALS,
  fixFor,
  fixTitle,
  pinned,
  sdkScaffold,
  SDK_REFUSAL_CODES,
  SdkFixProvider,
  TSCONFIG,
  typesPath,
} from "../functions/sdk";
import { decodeRefusal, publishSource } from "../functions/wire";

const MANIFEST = `${JSON.stringify(
  {
    apiVersion: "airdress.function/v1",
    id: "local.hello",
    name: "Hello",
    version: "0.1.0",
    entry: "src/main.ts",
    runtime: "js-source/v1",
    minHost: "airdress.function-host/1.0",
    capabilities: [{ name: "airdress:fn/log@0.1.0" }],
    triggers: [{ type: "http", path: "/" }],
  },
  null,
  2,
)}\n`;

/** An operator answering the library's two routes, or 404 for both. */
function clientWith(carries: boolean, calls: string[] = []): ApiClient {
  return new ApiClient({
    baseUrl: "https://ada.a.airdr.es",
    getToken: async () => "bearer-1",
    fetchFn: (async (input: URL | string) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (!carries) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "not_found" }),
          text: async () => "not found",
        } as unknown as Response;
      }
      const body =
        url.pathname === "/v1/functions/sdk"
          ? {
              prefix: "@airdress/functions/",
              newest: "1.0.0",
              versions: [
                { version: "1.0.0", digest: "sha256:d", status: "current" },
              ],
            }
          : {
              version: "1.0.0",
              digest: "sha256:d",
              status: "current",
              files: {
                "sdk.d.ts": 'declare module "@airdress/functions/geo" {}\n',
                "geo.js": "export const geo = {};",
              },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    }) as typeof fetch,
  });
}

suite("Functions SDK: a new function gets the library's pin and types", () => {
  test("the pin sits beside minHost, and a template's own pin is kept", () => {
    const out = JSON.parse(pinned(MANIFEST, "1.0.0")) as Record<
      string,
      unknown
    >;
    assert.strictEqual(out.sdk, "1.0.0");
    const keys = Object.keys(out);
    assert.strictEqual(keys[keys.indexOf("minHost") + 1], "sdk");
    const pinnedAlready = pinned(MANIFEST, "1.0.0");
    assert.strictEqual(pinned(pinnedAlready, "2.0.0"), pinnedAlready);
  });

  test("types, tsconfig and test/ come from the operator, none under src/", async () => {
    const calls: string[] = [];
    const files = await sdkScaffold(clientWith(true, calls), MANIFEST, false);
    const paths = files.map((f) => f.path);
    assert.deepStrictEqual(paths, [
      "function.json",
      typesPath("1.0.0"),
      "tsconfig.json",
      "test/README.md",
    ]);
    assert.ok(paths.every((p) => !p.startsWith("src/")));
    assert.strictEqual(typesPath("1.0.0"), ".airdress/sdk-1.0.0.d.ts");
    assert.ok(files[1].content.includes("@airdress/functions/geo"));
    assert.ok(
      (JSON.parse(TSCONFIG) as { include: string[] }).include.includes(
        ".airdress",
      ),
    );
    assert.deepStrictEqual(calls, [
      "/v1/functions/sdk",
      "/v1/functions/sdk/1.0.0",
    ]);
    // A tsconfig already there is left alone.
    const kept = await sdkScaffold(clientWith(true), MANIFEST, true);
    assert.ok(!kept.some((f) => f.path === "tsconfig.json"));
  });

  test("an operator that predates the library adds nothing", async () => {
    assert.deepStrictEqual(
      await sdkScaffold(clientWith(false), MANIFEST, false),
      [],
    );
  });
});

suite(
  "Functions SDK: the operator's fix is a quick fix on function.json",
  () => {
    const capFix = {
      file: "function.json",
      add: {
        capabilities: [
          { name: "airdress:fn/kv@0.1.0" },
          { name: "airdress:fn/log@0.1.0" },
        ],
      },
    };

    test("a capability is added once, and a pin is set", () => {
      const out = JSON.parse(applyFix(MANIFEST, capFix) ?? "null") as {
        capabilities: Array<{ name: string }>;
      };
      assert.deepStrictEqual(
        out.capabilities.map((c) => c.name),
        ["airdress:fn/log@0.1.0", "airdress:fn/kv@0.1.0"],
      );
      const set = JSON.parse(
        applyFix(MANIFEST, { file: "function.json", set: { sdk: "1.0.1" } }) ??
          "null",
      ) as { sdk: string };
      assert.strictEqual(set.sdk, "1.0.1");
      assert.strictEqual(applyFix("[1]", capFix), undefined);
      assert.strictEqual(applyFix("not json", capFix), undefined);
      assert.strictEqual(
        fixTitle(capFix),
        "Airdress: in function.json, request airdress:fn/kv@0.1.0, airdress:fn/log@0.1.0",
      );
    });

    test("a refusal's fix is decoded, placed at the import, and offered", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-fix-"));
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "function.json"), MANIFEST);
      fs.writeFileSync(
        path.join(dir, "src/main.ts"),
        'import { dwell } from "@airdress/functions/dwell";\nexport default () => new Response("x");\n',
      );
      const root = vscode.Uri.file(dir);
      const refusal = decodeRefusal({
        error: "sdk_capability_not_requested",
        reason: "SdkCapabilityNotRequested",
        message:
          "src/main.ts:1:1 imports @airdress/functions/dwell, which needs airdress:fn/kv",
        locations: [{ path: "src/main.ts", line: 1, column: 1 }],
        fix: capFix,
      });
      assert.ok(refusal?.fix);
      const placed = refusalDiagnostics(root, refusal);
      assert.strictEqual(placed.length, 1);
      assert.strictEqual(
        placed[0].uri.toString(),
        vscode.Uri.joinPath(root, "src/main.ts").toString(),
      );
      const d = placed[0].diagnostic;
      // What the Problems view hands back is a copy: found by what it says.
      const copy = new vscode.Diagnostic(d.range, d.message, d.severity);
      copy.code = d.code;
      assert.ok(fixFor(placed[0].uri, copy));

      const doc = await vscode.workspace.openTextDocument(placed[0].uri);
      const actions = await new SdkFixProvider().provideCodeActions(
        doc,
        d.range,
        {
          diagnostics: [copy],
          only: undefined,
          triggerKind: vscode.CodeActionTriggerKind.Invoke,
        },
      );
      assert.strictEqual(actions.length, 1);
      assert.ok(await vscode.workspace.applyEdit(actions[0].edit!));
      const manifestDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(root, "function.json"),
      );
      const after = JSON.parse(manifestDoc.getText()) as {
        capabilities: Array<{ name: string }>;
      };
      assert.ok(
        after.capabilities.some((c) => c.name === "airdress:fn/kv@0.1.0"),
      );
    });

    test("a refusal without a fix offers none", () => {
      const refusal = decodeRefusal({
        error: "sdk_module_unknown",
        message: "sdk 1.0.0 has no module nope",
        locations: [{ path: "src/main.ts", line: 2, column: 1 }],
      });
      assert.ok(refusal && refusal.fix === undefined);
      assert.strictEqual(
        decodeRefusal({
          error: "x",
          message: "y",
          fix: { file: "function.json" },
        })?.fix,
        undefined,
        "a fix with nothing to do is no fix",
      );
    });
  },
);

suite("Functions SDK: notes are information, never refusals", () => {
  test("a note lands where it points, else on function.json", () => {
    const root = vscode.Uri.file("/ws/hello");
    const placed = noteDiagnostics(root, [
      { code: "sdk_module_alpha", message: "dwell is alpha" },
      {
        code: "sdk_tick_name_not_passed",
        message: "tickName reads a header",
        location: { path: "src/main.ts", line: 4 },
      },
    ]);
    assert.strictEqual(placed.length, 2);
    for (const p of placed) {
      assert.strictEqual(
        p.diagnostic.severity,
        vscode.DiagnosticSeverity.Information,
      );
      assert.strictEqual(p.diagnostic.source, DIAGNOSTIC_SOURCE);
    }
    assert.ok(placed[0].uri.path.endsWith("/function.json"));
    assert.ok(placed[1].uri.path.endsWith("/src/main.ts"));
    assert.strictEqual(placed[1].diagnostic.range.start.line, 3);
  });

  test("the check's answer carries the library and its notes", async () => {
    const client = new ApiClient({
      baseUrl: "https://ada.a.airdr.es",
      getToken: async () => "bearer-1",
      fetchFn: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            version: "sha256:v",
            name: "hello",
            files: [],
            entry: "src/main.ts",
            sourceDigest: "sha256:s",
            unreachable: [],
            warnings: [],
            sdk: {
              version: "1.0.0",
              digest: "sha256:d",
              modules: ["dwell", "kv"],
            },
            notes: [{ code: "sdk_module_alpha", message: "alpha" }, { bad: 1 }],
            dryRun: true,
            created: false,
          }),
        }) as unknown as Response) as typeof fetch,
    });
    const out = await publishSource(
      client,
      { name: "hello", files: [] },
      { dryRun: true },
    );
    assert.deepStrictEqual(out.sdk?.modules, ["dwell", "kv"]);
    assert.deepStrictEqual(out.notes, [
      { code: "sdk_module_alpha", message: "alpha" },
    ]);
  });
});

suite("Functions SDK: the library's refusals are one closed list", () => {
  test("the array equals sdk-refusals.txt, line for line", () => {
    const fixture = fs
      .readFileSync(
        path.resolve(
          __dirname,
          "..",
          "..",
          "src",
          "functions",
          "sdk-refusals.txt",
        ),
        "utf8",
      )
      .split("\n")
      .filter((l) => l.length > 0);
    assert.deepStrictEqual([...SDK_REFUSAL_CODES], fixture);
    for (const c of FIXABLE_SDK_REFUSALS) {
      assert.ok((SDK_REFUSAL_CODES as readonly string[]).includes(c), c);
    }
  });

  test("each is marked where it points, and only the fixable ones offer a fix", () => {
    const root = vscode.Uri.file("/ws/hello");
    const fixes: Record<string, unknown> = {
      sdk_not_pinned: { file: "function.json", set: { sdk: "1.0.0" } },
      sdk_version_withdrawn: { file: "function.json", set: { sdk: "1.0.1" } },
      sdk_capability_not_requested: {
        file: "function.json",
        add: { capabilities: [{ name: "airdress:fn/kv@0.1.0" }] },
      },
    };
    for (const code of SDK_REFUSAL_CODES) {
      const atManifest =
        code === "sdk_version_unknown" || code === "sdk_version_withdrawn";
      const loc = atManifest
        ? { path: "function.json" }
        : { path: "src/main.ts", line: 2, column: 1 };
      const refusal = decodeRefusal({
        error: code,
        message: `refused: ${code}`,
        locations: [loc],
        ...(fixes[code] ? { fix: fixes[code] } : {}),
      });
      assert.ok(refusal, code);
      const placed = refusalDiagnostics(root, refusal);
      assert.strictEqual(placed.length, 1, code);
      assert.ok(placed[0].uri.path.endsWith(`/${loc.path}`), code);
      assert.strictEqual(
        placed[0].diagnostic.severity,
        vscode.DiagnosticSeverity.Error,
        code,
      );
      assert.strictEqual(
        fixFor(placed[0].uri, placed[0].diagnostic) !== undefined,
        (FIXABLE_SDK_REFUSALS as readonly string[]).includes(code),
        code,
      );
    }
  });
});
