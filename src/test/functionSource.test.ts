import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import { namesTarget } from "../profiles/confirm";
import {
  applyDiagnostics,
  DIAGNOSTIC_SOURCE,
  refusalDiagnostics,
} from "../functions/diagnostics";
import {
  canonicalDigestString,
  CHECKOUT_FILE,
  parseCheckoutRecord,
  publishBody,
  readCheckout,
  signingKeyFromSeedText,
  type SigningChoice,
} from "../functions/local";
import {
  publishCheckout,
  servedUri,
  parseServedUri,
  SHOW_DIFFERENCE,
  sourceListing,
  validateOnSave,
  type SourceDeps,
  type SourceUI,
} from "../functions/source";
import { decodeRefusal, fileRoute } from "../functions/wire";
import { ResourcesTreeProvider } from "../tree/provider";
import { ProfileStore } from "../profiles/store";
import type { TreeFetchers, TreeNodeData } from "../tree/nodes";

const PROFILE: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

const V1 = `sha256:${"1".repeat(64)}`;
const V2 = `sha256:${"2".repeat(64)}`;

/** One recorded request. */
interface Call {
  method: string;
  url: string;
  body?: unknown;
}

type Route = (call: Call) => { status: number; body?: unknown } | undefined;

/** A fetch that answers from `route` and records every request. */
function fakeFetch(route: Route, calls: Call[]): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = route(call) ?? { status: 404, body: { error: "not_found" } };
    const text =
      typeof answer.body === "string"
        ? answer.body
        : JSON.stringify(answer.body ?? {});
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  }) as typeof fetch;
}

function clientWith(route: Route, calls: Call[]): ApiClient {
  return new ApiClient({
    baseUrl: "https://ada.a.airdr.es",
    getToken: async () => "bearer-1",
    fetchFn: fakeFetch(route, calls),
  });
}

/** A recording UI; `answers` pre-selects the button a prompt returns. */
class FakeUI implements SourceUI {
  readonly lines: string[] = [];
  readonly diffs: Array<{
    left: vscode.Uri;
    right: vscode.Uri;
    title: string;
  }> = [];
  warnActions: string[][] = [];
  constructor(
    private readonly answers: {
      warn?: string;
      confirm?: boolean;
      pick?: string;
    } = {},
  ) {}
  info(m: string) {
    this.lines.push(`info: ${m}`);
    return Promise.resolve(undefined);
  }
  warn(m: string, ...actions: string[]) {
    this.lines.push(`warn: ${m}`);
    this.warnActions.push(actions);
    return Promise.resolve(this.answers.warn);
  }
  error(m: string) {
    this.lines.push(`error: ${m}`);
  }
  confirm(m: string) {
    this.lines.push(`confirm: ${m}`);
    return Promise.resolve(this.answers.confirm ?? false);
  }
  pick(items: string[]) {
    return Promise.resolve(this.answers.pick ?? items[0]);
  }
  ask() {
    return Promise.resolve(undefined);
  }
  pickFolder() {
    return Promise.resolve(undefined);
  }
  diff(left: vscode.Uri, right: vscode.Uri, title: string) {
    this.diffs.push({ left, right, title });
    return Promise.resolve();
  }
  open() {
    return Promise.resolve();
  }
  status(m: string) {
    this.lines.push(`status: ${m}`);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "airdress-fn-"));
}

const ENTRY = "export default () => new Response('a');\n";

/** A checkout on disk: function.json, src/main.ts, and a record. */
function makeCheckout(
  record: Record<string, unknown> = {
    operator: PROFILE.fqdn,
    function: "relay",
    basedOn: V1,
  },
): string {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "function.json"),
    '{"entry":"src/main.ts","runtime":"js-source/v1"}',
  );
  fs.writeFileSync(path.join(dir, "src", "main.ts"), ENTRY);
  fs.writeFileSync(path.join(dir, CHECKOUT_FILE), JSON.stringify(record));
  return dir;
}

function depsWith(
  client: ApiClient,
  ui: SourceUI,
  diagnostics: vscode.DiagnosticCollection,
  signing: SigningChoice = {},
): SourceDeps {
  return {
    client: () => client,
    profileFor: (fqdn) => (fqdn === PROFILE.fqdn ? PROFILE : undefined),
    pickProfile: async () => PROFILE,
    diagnostics,
    signing: async () => signing,
    ui,
  };
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

suite("function source: refusal locations become markers", () => {
  const root = vscode.Uri.file("/work/relay");

  test("a location lands in its file, on its line and column (1-based → 0-based)", () => {
    const refusal = decodeRefusal({
      error: "transpile_failed",
      reason: "TranspileFailed",
      message: "Unexpected token",
      locations: [{ path: "src/lib/sign.ts", line: 12, column: 5 }],
    })!;
    const [placed] = refusalDiagnostics(root, refusal);
    assert.strictEqual(placed.uri.path, "/work/relay/src/lib/sign.ts");
    assert.strictEqual(placed.diagnostic.range.start.line, 11);
    assert.strictEqual(placed.diagnostic.range.start.character, 4);
    assert.strictEqual(placed.diagnostic.message, "Unexpected token");
    assert.strictEqual(placed.diagnostic.code, "TranspileFailed");
    assert.strictEqual(placed.diagnostic.source, DIAGNOSTIC_SOURCE);
    assert.strictEqual(
      placed.diagnostic.severity,
      vscode.DiagnosticSeverity.Error,
    );
  });

  test("an import cycle marks every member and links each to the others", () => {
    const refusal = decodeRefusal({
      error: "source_import_cycle",
      message: "cycle: src/a.ts → src/b.ts → src/a.ts",
      locations: [
        { path: "src/a.ts", line: 1 },
        { path: "src/b.ts", line: 3 },
      ],
    })!;
    const placed = refusalDiagnostics(root, refusal);
    assert.deepStrictEqual(
      placed.map((p) => [p.uri.path, p.diagnostic.range.start.line]),
      [
        ["/work/relay/src/a.ts", 0],
        ["/work/relay/src/b.ts", 2],
      ],
    );
    assert.strictEqual(placed[0].diagnostic.relatedInformation?.length, 1);
    assert.strictEqual(
      placed[0].diagnostic.relatedInformation?.[0].location.uri.path,
      "/work/relay/src/b.ts",
    );
  });

  test("a location with no line marks the file's first line, whole", () => {
    const [placed] = refusalDiagnostics(
      root,
      decodeRefusal({
        error: "source_entry_missing",
        message: "function.json: missing field entry",
        locations: [{ path: "function.json" }],
      })!,
    );
    assert.strictEqual(placed.uri.path, "/work/relay/function.json");
    assert.strictEqual(placed.diagnostic.range.start.line, 0);
    assert.strictEqual(placed.diagnostic.range.start.character, 0);
  });

  test("capabilities not granted mark function.json and name the grant path", () => {
    const placed = refusalDiagnostics(
      root,
      decodeRefusal({
        error: "capability_not_granted",
        message: "the tree requests more than spec.capabilities grants",
        denials: [
          {
            capability: "airdress:fn/kv",
            detail: "kv not granted",
            grantPath: "spec.capabilities.kv",
          },
        ],
      })!,
    );
    assert.strictEqual(placed.length, 1);
    assert.strictEqual(placed[0].uri.path, "/work/relay/function.json");
    assert.match(placed[0].diagnostic.message, /spec\.capabilities\.kv/);
  });

  test("a path that climbs out of the tree marks nothing, and no location marks nothing", () => {
    assert.deepStrictEqual(
      refusalDiagnostics(
        root,
        decodeRefusal({
          error: "source_path_unsafe",
          message: "climbs",
          locations: [{ path: "src/../../etc/passwd", line: 1 }],
        })!,
      ),
      [],
    );
    assert.deepStrictEqual(
      refusalDiagnostics(
        root,
        decodeRefusal({ error: "source_unsigned", message: "unsigned" })!,
      ),
      [],
    );
  });

  test("applying replaces this checkout's markers and leaves others alone", () => {
    const collection = vscode.languages.createDiagnosticCollection("t");
    try {
      const other = vscode.Uri.file("/elsewhere/x.ts");
      collection.set(other, [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "keep"),
      ]);
      collection.set(vscode.Uri.file("/work/relay/src/old.ts"), [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "stale"),
      ]);
      applyDiagnostics(
        collection,
        root,
        refusalDiagnostics(
          root,
          decodeRefusal({
            error: "transpile_failed",
            message: "bad",
            locations: [{ path: "src/main.ts", line: 2 }],
          })!,
        ),
      );
      assert.strictEqual(collection.get(other)?.length, 1);
      assert.strictEqual(
        collection.get(vscode.Uri.file("/work/relay/src/old.ts"))?.length ?? 0,
        0,
      );
      assert.strictEqual(
        collection.get(vscode.Uri.file("/work/relay/src/main.ts"))?.length,
        1,
      );
    } finally {
      collection.dispose();
    }
  });
});

suite("function source: the digest and the publish body", () => {
  test("the canonical digest agrees with every one of the operator's vectors", () => {
    const doc = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "..",
          "src",
          "test",
          "fixtures",
          "source-digest-vectors.json",
        ),
        "utf8",
      ),
    ) as {
      vectors: Array<{
        name: string;
        files: Record<string, string>;
        digest: string;
      }>;
    };
    assert.ok(doc.vectors.length >= 5);
    for (const v of doc.vectors) {
      const tree = new Map(
        Object.entries(v.files).map(([p, b64]) => [
          p,
          new Uint8Array(Buffer.from(b64, "base64")),
        ]),
      );
      assert.strictEqual(canonicalDigestString(tree), v.digest, v.name);
    }
  });

  test("a signed body verifies against the named key and carries no grant", () => {
    const seed = crypto.randomBytes(32).toString("hex");
    const key = signingKeyFromSeedText(`seed=${seed}\npubkey=ignored\n`);
    const tree = new Map([
      ["function.json", new Uint8Array(Buffer.from("{}"))],
      ["src/main.ts", new Uint8Array(Buffer.from(ENTRY))],
    ]);
    const body = publishBody("relay", V1, tree, { key });
    assert.strictEqual(body.basedOn, V1);
    assert.strictEqual(body.signer, key.publicKeyHex);
    assert.deepStrictEqual(Object.keys(body).sort(), [
      "basedOn",
      "files",
      "name",
      "signature",
      "signer",
    ]);
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(key.publicKeyHex, "hex"),
    ]);
    const digest = Buffer.from(
      canonicalDigestString(tree).slice("sha256:".length),
      "hex",
    );
    assert.ok(
      crypto.verify(
        null,
        digest,
        crypto.createPublicKey({ key: spki, format: "der", type: "spki" }),
        Buffer.from(body.signature!, "hex"),
      ),
    );
  });

  test("a machine signer is named by reference, not by key", () => {
    const key = signingKeyFromSeedText("ab".repeat(32));
    const body = publishBody("relay", null, new Map(), {
      key,
      machine: "ci-runner",
    });
    assert.deepStrictEqual(body.signerRef, { machine: "ci-runner" });
    assert.strictEqual(body.signer, undefined);
    assert.strictEqual(body.basedOn, undefined);
  });

  test("a seed file that is not a seed is refused without echoing it", () => {
    assert.throws(
      () => signingKeyFromSeedText("not-a-seed"),
      (e: Error) => !e.message.includes("not-a-seed"),
    );
  });

  test("the file route encodes each segment and keeps the slashes", () => {
    assert.strictEqual(
      fileRoute(V1, "src/lib/a b.ts"),
      `/v1/functions/sources/${encodeURIComponent(V1)}/files/src/lib/a%20b.ts`,
    );
  });

  test("served URIs round-trip", () => {
    const uri = servedUri("p1", V1, "src/lib/x.ts");
    assert.deepStrictEqual(parseServedUri(uri), {
      profileId: "p1",
      version: V1,
      path: "src/lib/x.ts",
    });
  });

  test("a checkout record parses, and anything else does not", () => {
    assert.ok(
      parseCheckoutRecord('{"operator":"a","function":"f","basedOn":null}'),
    );
    assert.strictEqual(parseCheckoutRecord('{"operator":"a"}'), undefined);
    assert.strictEqual(parseCheckoutRecord("nope"), undefined);
  });
});

suite("function source: validate on save is a dry run and nothing else", () => {
  test("a save inside a checkout sends one dry-run publish with basedOn, and a pass clears markers", async () => {
    const dir = makeCheckout();
    const calls: Call[] = [];
    const client = clientWith(
      (c) =>
        c.method === "POST"
          ? {
              status: 200,
              body: {
                version: V2,
                name: "relay",
                files: [],
                entry: "src/main.ts",
                unreachable: [],
                warnings: [],
                dryRun: true,
                created: false,
              },
            }
          : undefined,
      calls,
    );
    const collection = vscode.languages.createDiagnosticCollection("t");
    try {
      collection.set(vscode.Uri.file(path.join(dir, "src", "main.ts")), [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "old"),
      ]);
      const deps = depsWith(client, new FakeUI(), collection);
      let keyRead = false;
      deps.signing = async () => {
        keyRead = true;
        throw new Error("a save must not read the signing key");
      };
      const outcome = await validateOnSave(
        deps,
        vscode.Uri.file(path.join(dir, "src", "main.ts")),
      );
      assert.strictEqual(outcome?.kind, "ok");
      assert.strictEqual(keyRead, false, "a save needs no signing key");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].method, "POST");
      assert.ok(calls[0].url.endsWith("/v1/functions/sources?dry-run=true"));
      const body = calls[0].body as Record<string, unknown>;
      assert.ok(!("signature" in body), "the save's dry run is unsigned");
      assert.strictEqual(body.basedOn, V1);
      assert.strictEqual(body.name, "relay");
      assert.deepStrictEqual(
        (body.files as Array<{ path: string }>).map((f) => f.path),
        ["function.json", "src/main.ts"],
        "the checkout record is never part of the tree",
      );
      assert.strictEqual(
        collection.get(vscode.Uri.file(path.join(dir, "src", "main.ts")))
          ?.length ?? 0,
        0,
      );
    } finally {
      collection.dispose();
    }
  });

  test("a refusal on save puts the marker on the line the operator named", async () => {
    const dir = makeCheckout();
    const calls: Call[] = [];
    const client = clientWith(
      () => ({
        status: 422,
        body: {
          error: "transpile_failed",
          message: "Expected ';'",
          locations: [{ path: "src/main.ts", line: 1, column: 10 }],
        },
      }),
      calls,
    );
    const collection = vscode.languages.createDiagnosticCollection("t");
    try {
      const outcome = await validateOnSave(
        depsWith(client, new FakeUI(), collection),
        vscode.Uri.file(path.join(dir, "src", "main.ts")),
      );
      assert.strictEqual(outcome?.kind, "refused");
      const marks = collection.get(
        vscode.Uri.file(path.join(dir, "src", "main.ts")),
      );
      assert.strictEqual(marks?.length, 1);
      assert.strictEqual(marks?.[0].range.start.line, 0);
      assert.strictEqual(marks?.[0].range.start.character, 9);
      assert.ok(calls.every((c) => c.url.includes("dry-run=true")));
    } finally {
      collection.dispose();
    }
  });

  test("a save outside any checkout, or outside the tree, makes no request", async () => {
    const calls: Call[] = [];
    const client = clientWith(() => ({ status: 500 }), calls);
    const collection = vscode.languages.createDiagnosticCollection("t");
    try {
      const loose = tmpDir();
      fs.writeFileSync(path.join(loose, "x.ts"), "x");
      const dir = makeCheckout();
      fs.writeFileSync(path.join(dir, "README.md"), "hi");
      const deps = depsWith(client, new FakeUI(), collection);
      assert.strictEqual(
        await validateOnSave(deps, vscode.Uri.file(path.join(loose, "x.ts"))),
        undefined,
      );
      assert.strictEqual(
        await validateOnSave(
          deps,
          vscode.Uri.file(path.join(dir, "README.md")),
        ),
        undefined,
      );
      assert.strictEqual(calls.length, 0);
    } finally {
      collection.dispose();
    }
  });
});

suite(
  "function source: a stale base shows the difference, never retries",
  () => {
    const staleBody = {
      error: "source_base_stale",
      message: "the function has moved since this tree was read",
      basedOn: V1,
      current: V2,
      currentPublishedBy: "owner",
    };

    function staleRoute(servedMain: string): Route {
      return (c) => {
        if (c.method === "POST") {
          return { status: 409, body: staleBody };
        }
        if (c.url.endsWith(`/v1/functions/sources/${encodeURIComponent(V2)}`)) {
          return {
            status: 200,
            body: {
              version: V2,
              name: "relay",
              files: [
                {
                  path: "function.json",
                  bytes: 1,
                  sha256: sha(
                    '{"entry":"src/main.ts","runtime":"js-source/v1"}',
                  ),
                },
                { path: "src/main.ts", bytes: 1, sha256: sha(servedMain) },
              ],
            },
          };
        }
        return undefined;
      };
    }

    test("the only offer is Show the Difference, and it diffs served against local", async () => {
      const dir = makeCheckout();
      const calls: Call[] = [];
      const ui = new FakeUI({ warn: SHOW_DIFFERENCE, confirm: true });
      const collection = vscode.languages.createDiagnosticCollection("t");
      try {
        const outcome = await publishCheckout(
          depsWith(clientWith(staleRoute("served\n"), calls), ui, collection),
          (await readCheckout(vscode.Uri.file(dir)))!,
          { dryRun: false },
        );
        assert.strictEqual(outcome.kind, "stale");
        assert.deepStrictEqual(ui.warnActions, [[SHOW_DIFFERENCE]]);
        assert.strictEqual(
          calls.filter((c) => c.method === "POST").length,
          1,
          "a stale base is never retried",
        );
        assert.strictEqual(ui.diffs.length, 1);
        const [d] = ui.diffs;
        assert.deepStrictEqual(parseServedUri(d.left), {
          profileId: PROFILE.id,
          version: V2,
          path: "src/main.ts",
        });
        assert.strictEqual(d.right.fsPath, path.join(dir, "src", "main.ts"));
        assert.match(
          d.title,
          /served 222222222222 ⟷ your edit \(based on 111111111111\)/,
        );
        // The record is untouched: nothing moved the base on anyone's behalf.
        assert.strictEqual(
          (await readCheckout(vscode.Uri.file(dir)))!.record.basedOn,
          V1,
        );
      } finally {
        collection.dispose();
      }
    });

    test("the publish confirm names the target, and a cancel sends nothing", async () => {
      const dir = makeCheckout();
      const calls: Call[] = [];
      const ui = new FakeUI({ confirm: false });
      const collection = vscode.languages.createDiagnosticCollection("t");
      try {
        const outcome = await publishCheckout(
          depsWith(clientWith(staleRoute("x"), calls), ui, collection),
          (await readCheckout(vscode.Uri.file(dir)))!,
          { dryRun: false },
        );
        assert.strictEqual(outcome.kind, "cancelled");
        assert.strictEqual(calls.length, 0);
        const confirm = ui.lines.find((l) => l.startsWith("confirm: "))!;
        assert.ok(namesTarget(confirm, PROFILE), confirm);
      } finally {
        collection.dispose();
      }
    });

    test("when the served version is one this folder published, taking it as the base is offered — and still sends nothing", async () => {
      const dir = makeCheckout({
        operator: PROFILE.fqdn,
        function: "relay",
        basedOn: V1,
        published: [V2],
      });
      const calls: Call[] = [];
      const ui = new FakeUI({ warn: "Base on 222222222222" });
      const collection = vscode.languages.createDiagnosticCollection("t");
      try {
        await publishCheckout(
          depsWith(clientWith(staleRoute(ENTRY), calls), ui, collection),
          (await readCheckout(vscode.Uri.file(dir)))!,
          { dryRun: true },
        );
        assert.deepStrictEqual(ui.warnActions, [
          [SHOW_DIFFERENCE, "Base on 222222222222"],
        ]);
        assert.strictEqual(calls.length, 1, "no retry after rebasing");
        assert.strictEqual(
          (await readCheckout(vscode.Uri.file(dir)))!.record.basedOn,
          V2,
        );
      } finally {
        collection.dispose();
      }
    });

    test("a function served from an import says so, and is not reported as broken", async () => {
      const dir = makeCheckout();
      const ui = new FakeUI();
      const collection = vscode.languages.createDiagnosticCollection("t");
      try {
        const outcome = await publishCheckout(
          depsWith(
            clientWith(
              () => ({
                status: 409,
                body: {
                  error: "source_managed_externally",
                  message:
                    "function relay is served from an import (relay.tar.zst); it is read-only to this API.",
                },
              }),
              [],
            ),
            ui,
            collection,
          ),
          (await readCheckout(vscode.Uri.file(dir)))!,
          { dryRun: true },
        );
        assert.strictEqual(outcome.kind, "managed");
        assert.ok(
          ui.lines.some((l) => l.startsWith("info: ") && l.includes("import")),
        );
        assert.ok(!ui.lines.some((l) => l.startsWith("error: ")));
      } finally {
        collection.dispose();
      }
    });
  },
);

suite("function source: the listing and the tree", () => {
  function listingRoute(
    spec: Record<string, unknown>,
    current: string | null,
  ): Route {
    return (c) => {
      if (c.url.endsWith("/v1/kinds/Function/relay")) {
        return {
          status: 200,
          body: {
            apiVersion: "airdress.co/v1alpha1",
            kind: "Function",
            metadata: { name: "relay" },
            spec,
          },
        };
      }
      if (c.url.endsWith("/v1/functions/relay/versions")) {
        return { status: 200, body: { name: "relay", current } };
      }
      if (c.url.includes("/v1/functions/sources/")) {
        return {
          status: 200,
          body: {
            version: current,
            name: "relay",
            files: [
              { path: "function.json", bytes: 40, sha256: "a" },
              { path: "src/main.ts", bytes: 20, sha256: "b" },
            ],
          },
        };
      }
      return undefined;
    };
  }

  test("a source function lists the served version's files", async () => {
    const listing = await sourceListing(
      clientWith(listingRoute({ source: { version: V1 } }, V1), []),
      "relay",
    );
    assert.strictEqual(listing.kind, "files");
    assert.ok(listing.kind === "files");
    assert.deepStrictEqual(
      listing.files.map((f) => f.path),
      ["function.json", "src/main.ts"],
    );
    assert.strictEqual(listing.importedFrom, undefined);
  });

  test("an imported function lists its files and says who owns them", async () => {
    const listing = await sourceListing(
      clientWith(
        listingRoute({ source: { import: { path: "relay.tar.zst" } } }, V1),
        [],
      ),
      "relay",
    );
    assert.ok(listing.kind === "files");
    assert.strictEqual(listing.importedFrom, "relay.tar.zst");
  });

  test("a bundle function has nothing to list, and says why", async () => {
    const calls: Call[] = [];
    const listing = await sourceListing(
      clientWith(listingRoute({ bundle: { path: "r.tar.zst" } }, null), calls),
      "relay",
    );
    assert.strictEqual(listing.kind, "none");
    assert.strictEqual(calls.length, 1);
  });

  test("Function rows expand into files that open the served version", async () => {
    const memento = new Map<string, unknown>();
    const store = new ProfileStore({
      get: (k: string, d?: unknown) => (memento.has(k) ? memento.get(k) : d),
      update: async (k: string, v: unknown) => {
        memento.set(k, v);
      },
      keys: () => [...memento.keys()],
    } as unknown as vscode.Memento);
    await store.add(PROFILE);
    await store.setActive(PROFILE.id);
    const fetchers: TreeFetchers = {
      listKinds: async () => ["Function"],
      listResources: async () => [{ kind: "Function", name: "relay" }],
      listPrincipals: async () => [],
      listEnrollments: async () => [],
      getStatus: async () => ({ ready: true, state: "Ready" }),
      listSourceFiles: async () => ({
        kind: "files",
        version: V1,
        files: [{ path: "src/main.ts", bytes: 20, sha256: "b" }],
      }),
    };
    const provider = new ResourcesTreeProvider(store, fetchers);
    const row: TreeNodeData = {
      type: "resource",
      profile: PROFILE,
      resource: { kind: "Function", name: "relay" },
    };
    assert.strictEqual(
      provider.getTreeItem(row).collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const [file] = await provider.getChildren(row);
    assert.strictEqual(file.type, "sourceFile");
    const item = provider.getTreeItem(file);
    assert.strictEqual(
      item.command?.command,
      "airdress.functions.source.openFile",
    );
    assert.strictEqual(item.contextValue, "airdressSourceFile");
  });
});

suite("function source: a publish signs only what the operator digests", () => {
  function publishRoute(
    digest: (tree: Map<string, Uint8Array>) => string,
  ): Route {
    return (c) => {
      if (c.method !== "POST") {
        return undefined;
      }
      const sent = c.body as {
        files: Array<{ path: string; contentBase64: string }>;
      };
      const tree = new Map(
        sent.files.map((f) => [
          f.path,
          new Uint8Array(Buffer.from(f.contentBase64, "base64")),
        ]),
      );
      const dryRun = c.url.includes("dry-run=true");
      return {
        status: dryRun ? 200 : 201,
        body: {
          version: V2,
          name: "relay",
          files: [],
          entry: "src/main.ts",
          sourceDigest: digest(tree),
          unreachable: [],
          warnings: [],
          dryRun,
          created: !dryRun,
        },
      };
    };
  }

  test("an unsigned check, then one signed publish over the agreed digest", async () => {
    const dir = makeCheckout();
    const calls: Call[] = [];
    const key = signingKeyFromSeedText("ef".repeat(32));
    const collection = vscode.languages.createDiagnosticCollection("t");
    try {
      const outcome = await publishCheckout(
        depsWith(
          clientWith(publishRoute(canonicalDigestString), calls),
          new FakeUI({ confirm: true }),
          collection,
          { key },
        ),
        (await readCheckout(vscode.Uri.file(dir)))!,
        { dryRun: false },
      );
      assert.strictEqual(outcome.kind, "ok");
      assert.deepStrictEqual(
        calls.map((c) => c.url.replace("https://ada.a.airdr.es", "")),
        ["/v1/functions/sources?dry-run=true", "/v1/functions/sources"],
      );
      assert.ok(!("signature" in (calls[0].body as object)));
      const signed = calls[1].body as { signature: string; signer: string };
      assert.strictEqual(signed.signer, key.publicKeyHex);
      assert.strictEqual(signed.signature.length, 128);
      assert.deepStrictEqual(
        (await readCheckout(vscode.Uri.file(dir)))!.record.published,
        [V2],
      );
    } finally {
      collection.dispose();
    }
  });

  test("a digest mismatch is an error, and nothing is signed or stored", async () => {
    const dir = makeCheckout();
    const calls: Call[] = [];
    const ui = new FakeUI({ confirm: true });
    let keyRead = false;
    const collection = vscode.languages.createDiagnosticCollection("t");
    try {
      const deps = depsWith(
        clientWith(
          publishRoute(() => `sha256:${"0".repeat(64)}`),
          calls,
        ),
        ui,
        collection,
      );
      deps.signing = async () => {
        keyRead = true;
        return {};
      };
      const outcome = await publishCheckout(
        deps,
        (await readCheckout(vscode.Uri.file(dir)))!,
        { dryRun: false },
      );
      assert.strictEqual(outcome.kind, "failed");
      assert.strictEqual(calls.length, 1, "only the unsigned check was sent");
      assert.strictEqual(keyRead, false);
      assert.ok(
        ui.lines.some(
          (l) =>
            l.startsWith("error: ") && l.includes("sha256:" + "0".repeat(64)),
        ),
      );
    } finally {
      collection.dispose();
    }
  });
});
