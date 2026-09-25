import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as YAML from "yaml";
import { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import { namesTarget } from "../profiles/confirm";
import {
  BLANK_TEMPLATE_ID,
  newSourceFunction,
  pickFunctionStart,
  START_CHOICES,
  SCRATCH_FOLDER,
  type CreateDeps,
  type CreateUI,
} from "../functions/createPick";
import {
  ALLOW_THIS_WORKSTATION,
  CREATE_AND_DEPLOY,
  CREATE_KEY,
  DEPLOY,
  deployCheckout,
  EDIT_GRANT_FIRST,
  WIDEN_GRANT,
  waitForLoaded,
  type Clock,
  type DeployDeps,
  type DeployOutcome,
} from "../functions/deploy";
import {
  OWNER_MANIFEST_FILE,
  ownerManifestDraft,
  parseOwnerManifest,
  withServedVersion,
} from "../functions/functionManifest";
import {
  canonicalDigestString,
  CHECKOUT_FILE,
  parseCheckoutRecord,
  signingKeyFromSeedText,
  type Checkout,
  type SigningChoice,
} from "../functions/local";
import {
  allowAnotherSigner,
  removeSigner,
  type SignerFlowDeps,
} from "../functions/signerFlows";
import {
  allowedSigners,
  isMember,
  MAX_SIGNERS,
  SignerSetError,
  sourceWithMember,
  sourceWithoutMember,
  type SignerMember,
} from "../functions/signers";
import {
  createKeychainKey,
  exportKeychainKey,
  resolveSigning,
  SIGNING_SEED_SECRET,
  type SecretStore,
} from "../functions/signingKey";
import { sourceListing, type SourceUI } from "../functions/source";
import { ProfileStore } from "../profiles/store";
import { ResourcesTreeProvider } from "../tree/provider";
import type { TreeFetchers } from "../tree/nodes";
import { DEPLOY_STOP_CODES } from "../functions/stops";

const PROFILE: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

const V1 = `sha256:${"1".repeat(64)}`;
const V2 = `sha256:${"2".repeat(64)}`;
const SEED = "cd".repeat(32);
const OTHER_KEY = "01234567".repeat(8);

/** One recorded request, headers included. */
interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  raw?: string;
  body?: unknown;
}

type Route = (call: Call) => { status: number; body?: unknown } | undefined;

function fakeFetch(route: Route, calls: Call[]): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      path: url.pathname + url.search,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      raw,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const answer = route(call) ?? {
      status: 404,
      body: { error: "not_found", message: "no route" },
    };
    const text = JSON.stringify(answer.body ?? {});
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  }) as typeof fetch;
}

/** A recording UI. `warn` answers with the first action offered in `warnPick`. */
class FakeUI implements SourceUI {
  readonly lines: string[] = [];
  readonly warnActions: string[][] = [];
  readonly opened: vscode.Uri[] = [];
  constructor(private readonly warnPick: string[] = []) {}
  info(m: string) {
    this.lines.push(`info: ${m}`);
    return Promise.resolve(undefined);
  }
  warn(m: string, ...actions: string[]) {
    this.lines.push(`warn: ${m}`);
    this.warnActions.push(actions);
    return Promise.resolve(actions.find((a) => this.warnPick.includes(a)));
  }
  error(m: string) {
    this.lines.push(`error: ${m}`);
  }
  confirm() {
    return Promise.resolve(false);
  }
  pick(items: string[]) {
    return Promise.resolve(items[0]);
  }
  ask() {
    return Promise.resolve(undefined);
  }
  pickFolder() {
    return Promise.resolve(undefined);
  }
  diff() {
    return Promise.resolve();
  }
  open(uri: vscode.Uri) {
    this.opened.push(uri);
    return Promise.resolve();
  }
  status(m: string) {
    this.lines.push(`status: ${m}`);
  }
}

/** An in-memory keychain. */
class MemorySecrets implements SecretStore {
  readonly map = new Map<string, string>();
  get(k: string) {
    return Promise.resolve(this.map.get(k));
  }
  store(k: string, v: string) {
    this.map.set(k, v);
    return Promise.resolve();
  }
}

/** A clock that only moves when the loop sleeps. */
function fakeClock(): Clock & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "airdress-deploy-"));
}

/** A folder bound to `relay`: function.json, src/main.ts, the record. */
function makeFolder(
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
  fs.writeFileSync(
    path.join(dir, "src", "main.ts"),
    "export default () => new Response('a');\n",
  );
  fs.writeFileSync(path.join(dir, CHECKOUT_FILE), JSON.stringify(record));
  return dir;
}

function checkoutOf(dir: string): Checkout {
  return {
    root: vscode.Uri.file(dir),
    record: parseCheckoutRecord(
      fs.readFileSync(path.join(dir, CHECKOUT_FILE), "utf8"),
    )!,
  };
}

function treeOf(body: unknown): Map<string, Uint8Array> {
  const sent = body as {
    files: Array<{ path: string; contentBase64: string }>;
  };
  return new Map(
    sent.files.map((f) => [
      f.path,
      new Uint8Array(Buffer.from(f.contentBase64, "base64")),
    ]),
  );
}

/** A Function as `GET /v1/kinds/Function/{name}` answers it. */
function view(
  spec: Record<string, unknown>,
  opts: {
    generation?: number;
    observed?: number;
    loaded?: "True" | "False";
    reason?: string;
    serving?: string;
  } = {},
) {
  return {
    apiVersion: "airdress.co/v1alpha1",
    kind: "Function",
    metadata: {
      name: "relay",
      generation: opts.generation ?? 3,
      observed_generation: opts.observed ?? opts.generation ?? 3,
      resourceVersion: "41",
      labels: {},
    },
    spec,
    status: {
      conditions: opts.loaded
        ? [
            {
              type: "Loaded",
              status: opts.loaded,
              reason: opts.reason ?? "Loaded",
            },
          ]
        : [],
      ...(opts.serving ? { sourceVersion: opts.serving } : {}),
    },
  };
}

/**
 * A small operator: one Function (or none), the source routes, promote
 * and apply. Its answers change as the writes land, as the real one's do.
 */
function fakeOperator(opts: {
  spec?: Record<string, unknown>;
  digest?: (tree: Map<string, Uint8Array>) => string;
  checkRefusal?: { status: number; body: unknown };
  promoteAnswer?: { status: number; body: unknown };
  loaded?: "True" | "False";
  loadAfterPolls?: number;
}) {
  let spec = opts.spec;
  let generation = 3;
  let observed = 3;
  let serving = spec && (spec.source as { version?: string })?.version;
  let polls = 0;
  const route: Route = (c) => {
    if (c.method === "GET" && c.path === "/v1/kinds/Function/relay") {
      if (!spec) {
        return { status: 404, body: { error: "not_found" } };
      }
      polls++;
      if (polls > (opts.loadAfterPolls ?? 1)) {
        observed = generation;
        serving = (spec.source as { version?: string }).version;
      }
      return {
        status: 200,
        body: view(spec, {
          generation,
          observed,
          loaded: observed === generation ? (opts.loaded ?? "True") : "True",
          serving,
        }),
      };
    }
    if (c.method === "GET" && c.path === "/v1/admin/machines") {
      return {
        status: 200,
        body: {
          machines: [
            {
              machine_id: "0b7e3c1a-0000-4000-8000-00000000009d",
              name: "ci-functions",
              fingerprint: "SHA256:abc",
              approved_at: "2026-09-01T00:00:00Z",
              revoked_at: null,
            },
          ],
        },
      };
    }
    if (c.method === "GET" && c.path.startsWith("/v1/functions/sources/")) {
      return {
        status: 200,
        body: {
          version: V1,
          name: "relay",
          files: [],
          signer: OTHER_KEY,
          publishedAt: "2026-09-25T13:29:00Z",
        },
      };
    }
    if (c.method === "POST" && c.path.startsWith("/v1/functions/sources")) {
      const dryRun = c.path.includes("dry-run=true");
      if (dryRun && opts.checkRefusal) {
        return opts.checkRefusal;
      }
      const tree = treeOf(c.body);
      return {
        status: dryRun ? 200 : 201,
        body: {
          version: V2,
          name: "relay",
          files: [],
          entry: "src/main.ts",
          sourceDigest: (opts.digest ?? canonicalDigestString)(tree),
          unreachable: [],
          warnings: [],
          dryRun,
          created: !dryRun,
        },
      };
    }
    if (c.method === "POST" && c.path === "/v1/functions/relay/promote") {
      if (opts.promoteAnswer) {
        return opts.promoteAnswer;
      }
      const body = c.body as { version: string };
      const previous = (spec!.source as { version?: string }).version ?? null;
      spec = {
        ...spec,
        source: { ...(spec!.source as object), version: body.version },
      };
      generation++;
      return {
        status: 200,
        body: {
          name: "relay",
          version: body.version,
          previous,
          generation,
          changed: true,
        },
      };
    }
    if (c.method === "POST" && c.path === "/v1/apply") {
      spec = (c.body as { spec: Record<string, unknown> }).spec;
      generation = 1;
      observed = 0;
      return {
        status: 201,
        body: {
          kind: "Function",
          name: "relay",
          action: "created",
          generation,
        },
      };
    }
    return undefined;
  };
  return { route };
}

interface Harness {
  deps: DeployDeps;
  calls: Call[];
  ui: FakeUI;
  chosen: Array<{ message: string; detail: string; actions: string[] }>;
  drafts: string[];
  allowed: SignerMember[];
  secrets: MemorySecrets;
}

function harness(
  route: Route,
  opts: {
    signing?: SigningChoice;
    choose?: string[];
    warnPick?: string[];
    secrets?: MemorySecrets;
    timeoutMs?: number;
  } = {},
): Harness {
  const calls: Call[] = [];
  const ui = new FakeUI(opts.warnPick);
  const chosen: Harness["chosen"] = [];
  const drafts: string[] = [];
  const allowed: SignerMember[] = [];
  const secrets = opts.secrets ?? new MemorySecrets();
  const client = new ApiClient({
    baseUrl: `https://${PROFILE.fqdn}`,
    getToken: async () => "bearer-1",
    fetchFn: fakeFetch(route, calls),
  });
  const signing = async () =>
    opts.signing ?? resolveSigning({ keyFile: "", machine: "" }, secrets);
  const deps: DeployDeps = {
    client: () => client,
    profileFor: (fqdn) => (fqdn === PROFILE.fqdn ? PROFILE : undefined),
    pickProfile: async () => PROFILE,
    diagnostics: vscode.languages.createDiagnosticCollection("deploy-test"),
    signing,
    ui,
    createKey: async () => ({
      key: await createKeychainKey(secrets),
      origin: "keychain",
    }),
    isOwner: (p) => p.authMode === "zitadel",
    choose: async (message, detail, ...actions) => {
      chosen.push({ message, detail, actions });
      return actions.find((a) => (opts.choose ?? []).includes(a));
    },
    openDraft: async (yaml) => {
      drafts.push(yaml);
    },
    allowSigner: async (_p, _n, member) => {
      allowed.push(member);
    },
    clock: fakeClock(),
    waitTimeoutMs: opts.timeoutMs ?? 60_000,
  };
  return { deps, calls, ui, chosen, drafts, allowed, secrets };
}

const MY_KEY = signingKeyFromSeedText(SEED);
const ME: SigningChoice = { key: MY_KEY, origin: "keychain" };

function sourceSpec(signers: unknown[] = [{ key: MY_KEY.publicKeyHex }]) {
  return {
    runtime: "js-source/v1",
    source: { version: V1, signers },
    capabilities: { log: {} },
    enabled: true,
  };
}

/** Method and path of every write, in order. */
function writes(calls: Call[]): string[] {
  return calls
    .filter((c) => c.method !== "GET")
    .map((c) => `${c.method} ${c.path}`);
}

suite("deploy: the stop codes are one closed list", () => {
  test("the enum equals deploy-stops.txt, line for line", () => {
    const fixture = fs
      .readFileSync(
        path.resolve(
          __dirname,
          "..",
          "..",
          "src",
          "functions",
          "deploy-stops.txt",
        ),
        "utf8",
      )
      .split("\n")
      .filter((l) => l.length > 0);
    assert.deepStrictEqual([...DEPLOY_STOP_CODES], fixture);
  });
});

suite("deploy: an existing function is changed by promote, in order", () => {
  test("resolve, check, confirm, publish (signed), promote, wait — and no apply", async () => {
    const op = fakeOperator({ spec: sourceSpec() });
    const h = harness(op.route, { signing: ME, choose: [DEPLOY] });
    const dir = makeFolder();
    const outcome = await deployCheckout(h.deps, checkoutOf(dir));
    assert.strictEqual(outcome.kind, "deployed", JSON.stringify(outcome));
    assert.deepStrictEqual(writes(h.calls), [
      "POST /v1/functions/sources?dry-run=true",
      "POST /v1/functions/sources",
      "POST /v1/functions/relay/promote",
    ]);
    const [check, publish, promote] = h.calls.filter(
      (c) => c.method === "POST",
    );
    // The check is unsigned; the publish carries the signature and the base.
    assert.strictEqual(
      (check.body as { signature?: string }).signature,
      undefined,
    );
    assert.strictEqual((check.body as { basedOn?: string }).basedOn, V1);
    assert.match(
      String((publish.body as { signature?: string }).signature),
      /^[0-9a-f]{128}$/,
    );
    assert.strictEqual(
      (publish.body as { signer?: string }).signer,
      MY_KEY.publicKeyHex,
    );
    assert.deepStrictEqual(promote.body, { version: V2, basedOn: V1 });
    // The one confirmation came before the first write, and names the target.
    assert.strictEqual(h.chosen.length, 1);
    assert.ok(namesTarget(h.chosen[0].message, PROFILE));
    assert.match(h.chosen[0].detail, /The grant does not change\./);
    assert.match(h.chosen[0].detail, /this workstation/);
    // The folder is now based on what it deployed.
    const record = parseCheckoutRecord(
      fs.readFileSync(path.join(dir, CHECKOUT_FILE), "utf8"),
    )!;
    assert.strictEqual(record.basedOn, V2);
    assert.ok(
      h.ui.lines.some((l) => /serving 222222222222/.test(l)),
      h.ui.lines.join("\n"),
    );
  });

  test("a digest the operator disagrees with stops before the prompt and before any signature", async () => {
    const op = fakeOperator({
      spec: sourceSpec(),
      digest: () => `sha256:${"9".repeat(64)}`,
    });
    const h = harness(op.route, { signing: ME, choose: [DEPLOY] });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.strictEqual(outcome.kind, "stopped");
    assert.strictEqual((outcome as { code: string }).code, "digest_mismatch");
    assert.deepStrictEqual(writes(h.calls), [
      "POST /v1/functions/sources?dry-run=true",
    ]);
    assert.strictEqual(h.chosen.length, 0);
    assert.ok(!h.calls.some((c) => c.raw?.includes('"signature"')));
  });

  test("declining the prompt writes nothing", async () => {
    const op = fakeOperator({ spec: sourceSpec() });
    const h = harness(op.route, { signing: ME, choose: [] });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.deepStrictEqual(
      (outcome as { code?: string }).code,
      "confirmation_declined",
    );
    assert.deepStrictEqual(writes(h.calls), [
      "POST /v1/functions/sources?dry-run=true",
    ]);
  });

  test("a retried promote that already landed reads as unchanged, not as a stop", async () => {
    const op = fakeOperator({
      spec: sourceSpec(),
      promoteAnswer: {
        status: 409,
        body: {
          error: "source_base_stale",
          message: "moved",
          basedOn: V1,
          current: V2,
        },
      },
    });
    const h = harness(op.route, { signing: ME, choose: [DEPLOY] });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.deepStrictEqual(outcome, { kind: "unchanged", version: V2 });
  });

  test("any other stale base offers Show the Difference and never retries", async () => {
    const op = fakeOperator({
      spec: sourceSpec(),
      checkRefusal: {
        status: 409,
        body: {
          error: "source_base_stale",
          message: "moved",
          basedOn: V1,
          current: `sha256:${"3".repeat(64)}`,
        },
      },
    });
    const h = harness(op.route, { signing: ME, choose: [DEPLOY] });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.strictEqual(outcome.kind, "stale");
    assert.deepStrictEqual(h.ui.warnActions.at(-1), ["Show the Difference"]);
    assert.deepStrictEqual(writes(h.calls), [
      "POST /v1/functions/sources?dry-run=true",
    ]);
  });

  test("a grant the check refuses offers Widen the Grant as its own draft, and stops", async () => {
    const op = fakeOperator({
      spec: sourceSpec(),
      checkRefusal: {
        status: 422,
        body: {
          error: "capability_not_granted",
          reason: "CapabilityNotGranted",
          message: "asks for http",
          locations: [],
          denials: [
            {
              capability: "http",
              detail: "host peer.example",
              grantPath: "spec.capabilities.http.hosts",
            },
          ],
        },
      },
    });
    const h = harness(op.route, {
      signing: ME,
      choose: [DEPLOY],
      warnPick: [WIDEN_GRANT],
    });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.strictEqual((outcome as { code?: string }).code, "check_failed");
    assert.strictEqual(h.drafts.length, 1);
    assert.match(h.drafts[0], /spec\.capabilities\.http\.hosts/);
    assert.match(h.drafts[0], /resourceVersion: "41"/);
    // Deploy itself sent no apply.
    assert.ok(!h.calls.some((c) => c.path === "/v1/apply"));
  });

  test("an operator with no promote route stops, and offers today's publish-then-apply", async () => {
    const op = fakeOperator({
      spec: sourceSpec(),
      promoteAnswer: { status: 404, body: {} },
    });
    const h = harness(op.route, {
      signing: ME,
      choose: [DEPLOY],
      warnPick: ["Draft the Manifest"],
    });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.strictEqual(
      (outcome as { code?: string }).code,
      "operator_predates_promote",
    );
    const draft = YAML.parse(h.drafts[0]) as {
      spec: { source: { version: string } };
    };
    assert.strictEqual(draft.spec.source.version, V2);
  });

  test("a version that fails to load stops with the condition's reason", async () => {
    const op = fakeOperator({ spec: sourceSpec(), loaded: "False" });
    const h = harness(op.route, { signing: ME, choose: [DEPLOY] });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.strictEqual((outcome as { code?: string }).code, "load_failed");
    assert.match((outcome as { message: string }).message, /promoted/);
  });
});

suite("deploy: who may sign", () => {
  test("a signer outside the set stops before the check, naming who may", async () => {
    const op = fakeOperator({
      spec: sourceSpec([
        { key: OTHER_KEY },
        { machine: "0b7e3c1a-0000-4000-8000-00000000009d" },
      ]),
    });
    const h = harness(op.route, {
      signing: ME,
      warnPick: [ALLOW_THIS_WORKSTATION],
    });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.strictEqual(
      (outcome as { code?: string }).code,
      "signer_not_this_client",
    );
    assert.deepStrictEqual(writes(h.calls), []);
    const said = h.ui.lines.join("\n");
    assert.match(said, /key 0123…4567/);
    assert.match(said, /machine ci-functions/);
    assert.match(said, /an apply by the owner/);
    // "Allow this workstation…" hands over to the signer-set flow.
    assert.deepStrictEqual(h.allowed, [{ key: MY_KEY.publicKeyHex }]);
  });

  test("no key: Deploy offers to make one, and declining stops with nothing sent", async () => {
    const op = fakeOperator({ spec: sourceSpec() });
    const h = harness(op.route, { choose: [] });
    const outcome = await deployCheckout(h.deps, checkoutOf(makeFolder()));
    assert.strictEqual(
      (outcome as { code?: string }).code,
      "signer_unavailable",
    );
    assert.deepStrictEqual(h.chosen[0].actions, [CREATE_KEY]);
    assert.deepStrictEqual(writes(h.calls), []);
    assert.strictEqual(h.secrets.map.size, 0);
  });

  test("the words people read never say 'seed'", async () => {
    const op = fakeOperator({});
    const h = harness(op.route, { choose: [CREATE_KEY, CREATE_AND_DEPLOY] });
    await deployCheckout(
      h.deps,
      checkoutOf(
        makeFolder({
          operator: PROFILE.fqdn,
          function: "relay",
          basedOn: null,
        }),
      ),
    );
    const said = [
      ...h.ui.lines,
      ...h.chosen.flatMap((c) => [c.message, c.detail]),
    ].join("\n");
    assert.ok(!/seed/i.test(said), said);
  });
});

suite("deploy: creating a function", () => {
  test("publish, then one apply writing the set form with this workstation's key, shown in full first", async () => {
    const op = fakeOperator({});
    const secrets = new MemorySecrets();
    const h = harness(op.route, {
      secrets,
      choose: [CREATE_KEY, CREATE_AND_DEPLOY],
    });
    const dir = makeFolder({
      operator: PROFILE.fqdn,
      function: "relay",
      basedOn: null,
      template: "webhook-relay",
    });
    fs.writeFileSync(
      path.join(dir, OWNER_MANIFEST_FILE),
      ownerManifestDraft({
        name: "relay",
        requires: { http: { hostsRequired: true }, log: {} },
        config: [{ name: "target", value: "x" }],
      }),
    );
    const outcome: DeployOutcome = await deployCheckout(
      h.deps,
      checkoutOf(dir),
    );
    assert.strictEqual(outcome.kind, "deployed", JSON.stringify(outcome));
    assert.strictEqual((outcome as { created: boolean }).created, true);
    assert.deepStrictEqual(writes(h.calls), [
      "POST /v1/functions/sources?dry-run=true",
      "POST /v1/functions/sources",
      "POST /v1/apply",
    ]);
    // A new function's check and publish carry no base.
    for (const c of h.calls.filter((c) =>
      c.path.startsWith("/v1/functions/sources"),
    )) {
      assert.strictEqual((c.body as { basedOn?: string }).basedOn, undefined);
    }
    const pub = signingKeyFromSeedText(
      secrets.map.get(SIGNING_SEED_SECRET)!,
    ).publicKeyHex;
    const applied = h.calls.find((c) => c.path === "/v1/apply")!.body as {
      spec: {
        source: Record<string, unknown>;
        capabilities: unknown;
        config: unknown;
      };
    };
    assert.deepStrictEqual(applied.spec.source, {
      version: V2,
      signers: [{ key: pub }],
    });
    assert.deepStrictEqual(applied.spec.capabilities, {
      http: { hosts: [] },
      log: {},
    });
    assert.deepStrictEqual(applied.spec.config, [
      { name: "target", value: "x" },
    ]);
    // The create prompt: the target, the template, the grant in full, the signer.
    const create = h.chosen.find((c) => c.actions.includes(CREATE_AND_DEPLOY))!;
    assert.deepStrictEqual(create.actions, [
      CREATE_AND_DEPLOY,
      EDIT_GRANT_FIRST,
    ]);
    assert.ok(namesTarget(create.message, PROFILE));
    assert.match(create.message, /from template "webhook-relay"/);
    assert.match(create.detail, /capabilities:\n\s+http:\n\s+hosts: \[\]/);
    assert.match(create.detail, /this workstation/);
    // function.yaml now names what runs, and kept its comments.
    const kept = fs.readFileSync(path.join(dir, OWNER_MANIFEST_FILE), "utf8");
    assert.match(kept, /^# The owner's manifest/);
    assert.strictEqual(
      (parseOwnerManifest(kept).spec.source as { version: string }).version,
      V2,
    );
  });

  test("Edit Grant First opens function.yaml and sends nothing past the check", async () => {
    const op = fakeOperator({});
    const h = harness(op.route, { signing: ME, choose: [EDIT_GRANT_FIRST] });
    const dir = makeFolder({
      operator: PROFILE.fqdn,
      function: "relay",
      basedOn: null,
    });
    const outcome = await deployCheckout(h.deps, checkoutOf(dir));
    assert.strictEqual(
      (outcome as { code?: string }).code,
      "confirmation_declined",
    );
    assert.deepStrictEqual(writes(h.calls), [
      "POST /v1/functions/sources?dry-run=true",
    ]);
    assert.ok(
      h.ui.opened.some((u) => u.path.endsWith(`/${OWNER_MANIFEST_FILE}`)),
    );
    assert.ok(fs.existsSync(path.join(dir, OWNER_MANIFEST_FILE)));
  });

  test("the private key never reaches the HTTP client, a message or a prompt", async () => {
    const op = fakeOperator({});
    const secrets = new MemorySecrets();
    const h = harness(op.route, {
      secrets,
      choose: [CREATE_KEY, CREATE_AND_DEPLOY],
    });
    const dir = makeFolder({
      operator: PROFILE.fqdn,
      function: "relay",
      basedOn: null,
    });
    const outcome = await deployCheckout(h.deps, checkoutOf(dir));
    assert.strictEqual(outcome.kind, "deployed");
    const seed = secrets.map.get(SIGNING_SEED_SECRET)!;
    assert.match(seed, /^[0-9a-f]{64}$/);
    const seedB64 = Buffer.from(seed, "hex").toString("base64");
    for (const c of h.calls) {
      const everything = [c.url, c.raw ?? "", JSON.stringify(c.headers)].join(
        " ",
      );
      assert.ok(!everything.includes(seed), `seed in ${c.method} ${c.path}`);
      assert.ok(!everything.includes(seedB64), `seed in ${c.method} ${c.path}`);
    }
    const said = [
      ...h.ui.lines,
      ...h.chosen.flatMap((c) => [c.message, c.detail]),
      fs.readFileSync(path.join(dir, OWNER_MANIFEST_FILE), "utf8"),
      fs.readFileSync(path.join(dir, CHECKOUT_FILE), "utf8"),
    ].join("\n");
    assert.ok(!said.includes(seed));
  });
});

suite("deploy: the wait", () => {
  test("backs off from 250 ms to 2 s, explains the compile, and gives up at the timeout", async () => {
    const calls: Call[] = [];
    const client = new ApiClient({
      baseUrl: `https://${PROFILE.fqdn}`,
      getToken: async () => "b",
      fetchFn: fakeFetch(
        () => ({
          status: 200,
          body: view(sourceSpec(), { generation: 4, observed: 3 }),
        }),
        calls,
      ),
    });
    const clock = fakeClock();
    const said: string[] = [];
    await assert.rejects(
      waitForLoaded(client, "relay", V2, 4, (m) => said.push(m), clock, 10_000),
      (err: Error & { code?: string }) => err.code === "not_loaded_in_time",
    );
    assert.deepStrictEqual(
      clock.slept.slice(0, 5),
      [250, 500, 1000, 2000, 2000],
    );
    assert.ok(said.some((m) => /compiles the engine/.test(m)));
  });

  test("a function not yet visible reads as the operator admitting after a restart", async () => {
    let n = 0;
    const client = new ApiClient({
      baseUrl: `https://${PROFILE.fqdn}`,
      getToken: async () => "b",
      fetchFn: fakeFetch(
        () =>
          ++n < 3
            ? { status: 404, body: { error: "not_found" } }
            : {
                status: 200,
                body: view(sourceSpec(), {
                  generation: 1,
                  loaded: "True",
                  serving: V2,
                }),
              },
        [],
      ),
    });
    const said: string[] = [];
    const elapsed = await waitForLoaded(
      client,
      "relay",
      V2,
      1,
      (m) => said.push(m),
      fakeClock(),
      10_000,
    );
    assert.strictEqual(elapsed, 750);
    assert.match(said[0], /admit functions after a restart/);
  });
});

suite("signers: the set", () => {
  const K = "ab".repeat(32);
  test("the single forms read as sets of one; the set form as written", () => {
    assert.deepStrictEqual(allowedSigners({ signer: K }), [{ key: K }]);
    assert.deepStrictEqual(allowedSigners({ signerRef: { machine: "m" } }), [
      { machine: "m" },
    ]);
    assert.deepStrictEqual(
      allowedSigners({ signers: [{ key: K }, { machine: "m" }] }),
      [{ key: K }, { machine: "m" }],
    );
    assert.deepStrictEqual(allowedSigners({ version: V1 }), []);
  });

  test("membership: a key by its hex, case-folded; a machine by name or id", () => {
    const machines = [
      { id: "0b7e", name: "ci", revoked: false, approved: true },
    ];
    assert.ok(isMember([{ key: MY_KEY.publicKeyHex.toUpperCase() }], ME));
    assert.ok(!isMember([{ key: K }], ME));
    assert.ok(
      isMember([{ machine: "0b7e" }], { ...ME, machine: "ci" }, machines),
    );
  });

  test("adding converts a single form and keeps every other field", () => {
    const next = sourceWithMember(
      { version: V1, signer: K },
      { machine: "0b7e" },
    );
    assert.deepStrictEqual(next, {
      version: V1,
      signers: [{ key: K }, { machine: "0b7e" }],
    });
  });

  test("a duplicate, a seventeenth member, and the last removal are refused", () => {
    assert.throws(
      () =>
        sourceWithMember({ signers: [{ key: K }] }, { key: K.toUpperCase() }),
      SignerSetError,
    );
    const full = {
      signers: Array.from({ length: MAX_SIGNERS }, (_, i) => ({
        key: i.toString(16).padStart(64, "0"),
      })),
    };
    assert.throws(() => sourceWithMember(full, { key: K }), /at most 16/);
    assert.throws(
      () => sourceWithoutMember({ signer: K }, { key: K }),
      /only signer/,
    );
  });
});

suite("signers: allow and remove are their own apply", () => {
  function signerHarness(
    spec: Record<string, unknown>,
    answers: { pick?: string[]; ask?: string; choose?: string },
  ) {
    const calls: Call[] = [];
    const chosen: Array<{ message: string; detail: string }> = [];
    const op = fakeOperator({ spec });
    const client = new ApiClient({
      baseUrl: `https://${PROFILE.fqdn}`,
      getToken: async () => "b",
      fetchFn: fakeFetch(op.route, calls),
    });
    const picks = [...(answers.pick ?? [])];
    const deps: SignerFlowDeps = {
      client: () => client,
      signing: async () => ME,
      createKey: async () => ME,
      ui: {
        pick: async (items) => {
          const want = picks.shift();
          return items.find((i) => i.label === want);
        },
        ask: async () => answers.ask,
        choose: async (message, detail, ...actions) => {
          chosen.push({ message, detail });
          return actions.find((a) => a === answers.choose);
        },
        info: () => undefined,
        error: (m) => {
          throw new Error(m);
        },
      },
    };
    return { deps, calls, chosen };
  }

  test("adding a machine shows the resulting set, then applies only that change, at the version read", async () => {
    const spec: Record<string, unknown> = {
      ...sourceSpec(),
      source: { version: V1, signer: MY_KEY.publicKeyHex },
    };
    const h = signerHarness(spec, {
      pick: ["An enrolled machine", "ci-functions"],
      choose: "Allow",
    });
    const outcome = await allowAnotherSigner(h.deps, PROFILE, "relay");
    assert.strictEqual(outcome, "applied");
    assert.ok(namesTarget(h.chosen[0].message, PROFILE));
    assert.match(h.chosen[0].detail, /this workstation/);
    assert.match(h.chosen[0].detail, /machine ci-functions/);
    const applies = h.calls.filter((c) => c.method === "POST");
    assert.strictEqual(applies.length, 1);
    const sent = applies[0].body as {
      metadata: { resourceVersion: string };
      spec: Record<string, unknown>;
    };
    assert.strictEqual(sent.metadata.resourceVersion, "41");
    assert.deepStrictEqual(sent.spec, {
      ...spec,
      source: {
        version: V1,
        signers: [
          { key: MY_KEY.publicKeyHex },
          { machine: "0b7e3c1a-0000-4000-8000-00000000009d" },
        ],
      },
    });
  });

  test("declining the prompt sends nothing", async () => {
    const h = signerHarness(sourceSpec(), {
      pick: ["A key, pasted"],
      ask: OTHER_KEY,
    });
    assert.strictEqual(
      await allowAnotherSigner(h.deps, PROFILE, "relay"),
      "cancelled",
    );
    assert.ok(!h.calls.some((c) => c.method === "POST"));
  });

  test("removing the member that signed the running version warns, naming it", async () => {
    const h = signerHarness(
      sourceSpec([{ key: MY_KEY.publicKeyHex }, { key: OTHER_KEY }]),
      { pick: ["key 0123…4567"], choose: "Remove" },
    );
    assert.strictEqual(await removeSigner(h.deps, PROFILE, "relay"), "applied");
    assert.match(h.chosen[0].detail, /signed the version relay runs now/);
    assert.match(h.chosen[0].detail, new RegExp(V1));
    const sent = h.calls.find((c) => c.method === "POST")!.body as {
      spec: { source: unknown };
    };
    assert.deepStrictEqual(sent.spec.source, {
      version: V1,
      signers: [{ key: MY_KEY.publicKeyHex }],
    });
  });
});

suite("signing key: made here, kept in the keychain", () => {
  test("a key file in settings wins over the keychain", async () => {
    const secrets = new MemorySecrets();
    await createKeychainKey(secrets);
    const file = path.join(tmpDir(), "k");
    fs.writeFileSync(file, `seed=${SEED}\n`);
    const choice = await resolveSigning(
      { keyFile: file, machine: "" },
      secrets,
    );
    assert.strictEqual(choice.origin, "file");
    assert.strictEqual(choice.key?.publicKeyHex, MY_KEY.publicKeyHex);
  });

  test("creating keeps it under its secret name and never replaces one", async () => {
    const secrets = new MemorySecrets();
    const a = await createKeychainKey(secrets);
    const b = await createKeychainKey(secrets);
    assert.strictEqual(a.publicKeyHex, b.publicKeyHex);
    assert.deepStrictEqual([...secrets.map.keys()], [SIGNING_SEED_SECRET]);
    const choice = await resolveSigning({ keyFile: "", machine: "" }, secrets);
    assert.strictEqual(choice.origin, "keychain");
  });

  test("export writes the form the command line reads, readable by its owner only", async () => {
    const secrets = new MemorySecrets();
    const key = await createKeychainKey(secrets);
    const file = path.join(tmpDir(), "exported.key");
    assert.ok(await exportKeychainKey(secrets, file));
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(
      signingKeyFromSeedText(fs.readFileSync(file, "utf8")).publicKeyHex,
      key.publicKeyHex,
    );
    assert.strictEqual(
      await exportKeychainKey(new MemorySecrets(), path.join(tmpDir(), "x")),
      false,
    );
  });
});

suite("function.yaml", () => {
  test("the draft parses as a Function with the template's grant and the form's config", () => {
    const text = ownerManifestDraft({
      name: "relay",
      requires: { http: { hostsRequired: true }, log: {} },
      config: [{ name: "token", valueFrom: { secretRef: "peer-token" } }],
    });
    const parsed = parseOwnerManifest(text);
    assert.strictEqual(parsed.name, "relay");
    assert.deepStrictEqual(parsed.spec, {
      runtime: "js-source/v1",
      capabilities: { http: { hosts: [] }, log: {} },
      config: [{ name: "token", valueFrom: { secretRef: "peer-token" } }],
      enabled: true,
    });
  });

  test("the served version is rewritten in place, and nothing else", () => {
    const text = [
      "# keep me",
      "apiVersion: airdress.co/v1alpha1",
      "kind: Function",
      "metadata:",
      "  name: relay",
      "spec:",
      "  source:",
      `    version: "${V1}" # the serving version`,
      "    signers:",
      "      - key: abc",
      "",
    ].join("\n");
    const out = withServedVersion(text, V2)!;
    assert.strictEqual(out, text.replace(V1, V2));
    assert.strictEqual(
      withServedVersion("kind: Function\nspec: {}\n", V2),
      undefined,
    );
  });
});

suite("the + on Function: template-first", () => {
  test("three choices, in the order people read them", async () => {
    assert.deepStrictEqual(
      START_CHOICES.map((c) => c.label),
      ["From a template", "Blank source function", "Bundle (advanced)"],
    );
    const ui = {
      pick: async <T extends vscode.QuickPickItem>(items: T[]) => items[2],
    };
    assert.strictEqual(await pickFunctionStart(ui), "bundle");
  });

  function createHarness(opts: { blankServed: boolean; pickLabel?: string }) {
    const calls: Call[] = [];
    const templates = [
      {
        id: "hello",
        title: "Answer a request",
        description: "",
        entry: "src/main.ts",
        requires: { log: {} },
        config: {
          fields: [
            {
              name: "greeting",
              type: "string",
              default: "hello",
              description: "The word.",
            },
          ],
        },
      },
      ...(opts.blankServed
        ? [
            {
              id: BLANK_TEMPLATE_ID,
              title: "Blank source function",
              description: "",
              entry: "src/main.ts",
              requires: {},
              config: { fields: [] },
            },
          ]
        : []),
    ];
    const route: Route = (c) => {
      if (c.path === "/v1/functions/templates") {
        return { status: 200, body: { templates } };
      }
      const m = /^\/v1\/functions\/templates\/([^?]+)\?functionId=(.+)$/.exec(
        c.path,
      );
      const t = m && templates.find((x) => x.id === m[1]);
      if (t) {
        return {
          status: 200,
          body: {
            ...t,
            files: {
              "function.json": `{"id":"${m[2]}","entry":"src/main.ts","runtime":"js-source/v1"}`,
              "src/main.ts": `export default () => new Response("hello from ${m[2]}\\n");\n`,
            },
          },
        };
      }
      return undefined;
    };
    const client = new ApiClient({
      baseUrl: `https://${PROFILE.fqdn}`,
      getToken: async () => "b",
      fetchFn: fakeFetch(route, calls),
    });
    const scratch = tmpDir();
    const said: string[] = [];
    const picks: string[] = [];
    const deployed: Checkout[] = [];
    const ui: CreateUI = {
      pick: async (items, placeHolder) => {
        picks.push(placeHolder);
        if (placeHolder.startsWith("Where")) {
          return items.find((i) => i.label === SCRATCH_FOLDER);
        }
        return items.find(
          (i) => i.label === (opts.pickLabel ?? items[0].label),
        );
      },
      ask: async (prompt, o) => (/^Name/.test(prompt) ? "my-fn" : o?.value),
      pickFolder: async () => undefined,
      open: async () => undefined,
      info: async (m, ...actions) => {
        said.push(m);
        return actions[0];
      },
      error: (m) => said.push(`error: ${m}`),
    };
    const deps: CreateDeps = {
      client: () => client,
      ui,
      scratchRoot: () => vscode.Uri.file(scratch),
      workspaceRoot: () => undefined,
      deploy: async (c) => {
        deployed.push(c);
      },
    };
    return { deps, calls, said, deployed, scratch, picks };
  }

  test("Blank scaffolds the operator's blank template for this name, writes function.yaml, offers Deploy", async () => {
    const h = createHarness({ blankServed: true });
    const checkout = await newSourceFunction(h.deps, PROFILE, "blank");
    assert.ok(checkout);
    // Only reads: nothing is sent until Deploy.
    assert.deepStrictEqual(
      h.calls.map((c) => `${c.method} ${c.path}`),
      ["GET /v1/functions/templates/blank?functionId=my-fn"],
    );
    const root = checkout.root.fsPath;
    assert.strictEqual(root, path.join(h.scratch, "my-fn"));
    assert.match(
      fs.readFileSync(path.join(root, "src", "main.ts"), "utf8"),
      /hello from my-fn/,
    );
    assert.deepStrictEqual(
      parseOwnerManifest(
        fs.readFileSync(path.join(root, OWNER_MANIFEST_FILE), "utf8"),
      ).spec,
      { runtime: "js-source/v1", enabled: true },
    );
    const record = parseCheckoutRecord(
      fs.readFileSync(path.join(root, CHECKOUT_FILE), "utf8"),
    )!;
    assert.deepStrictEqual(record, {
      operator: PROFILE.fqdn,
      function: "my-fn",
      basedOn: null,
      published: undefined,
      template: BLANK_TEMPLATE_ID,
    });
    assert.strictEqual(h.deployed.length, 1);
  });

  test("From a template lists the catalogue without blank, and carries the form into function.yaml", async () => {
    const h = createHarness({
      blankServed: true,
      pickLabel: "Answer a request",
    });
    const checkout = await newSourceFunction(h.deps, PROFILE, "template");
    assert.ok(checkout);
    assert.deepStrictEqual(
      h.calls.map((c) => `${c.method} ${c.path}`),
      [
        "GET /v1/functions/templates",
        "GET /v1/functions/templates/hello?functionId=my-fn",
      ],
    );
    const spec = parseOwnerManifest(
      fs.readFileSync(
        path.join(checkout.root.fsPath, OWNER_MANIFEST_FILE),
        "utf8",
      ),
    ).spec;
    assert.deepStrictEqual(spec.capabilities, { log: {} });
    assert.deepStrictEqual(spec.config, [{ name: "greeting", value: "hello" }]);
  });

  test("an operator without a blank template says so, and writes nothing", async () => {
    const h = createHarness({ blankServed: false });
    assert.strictEqual(
      await newSourceFunction(h.deps, PROFILE, "blank"),
      undefined,
    );
    assert.ok(h.said.some((m) => /does not serve a "blank" template/.test(m)));
    assert.deepStrictEqual(fs.readdirSync(h.scratch), []);
  });
});

suite("the function shows who may deploy it", () => {
  test("the listing names the set and who signed what runs, and the row shows both", async () => {
    const op = fakeOperator({
      spec: sourceSpec([
        { key: MY_KEY.publicKeyHex },
        { machine: "0b7e3c1a-0000-4000-8000-00000000009d" },
      ]),
    });
    const route: Route = (c) =>
      c.path === "/v1/functions/relay/versions"
        ? { status: 200, body: { current: V1 } }
        : op.route(c);
    const client = new ApiClient({
      baseUrl: `https://${PROFILE.fqdn}`,
      getToken: async () => "b",
      fetchFn: fakeFetch(route, []),
    });
    const listing = await sourceListing(client, "relay");
    assert.strictEqual(listing.kind, "files");
    if (listing.kind !== "files") {
      return;
    }
    assert.match(
      String(listing.signers),
      /^key [0-9a-f]{4}…[0-9a-f]{4}, machine ci-functions/,
    );
    assert.strictEqual(listing.runningSigner, "key 0123…4567");

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
      listSourceFiles: async () => listing,
    };
    const provider = new ResourcesTreeProvider(store, fetchers);
    const children = await provider.getChildren({
      type: "resource",
      profile: PROFILE,
      resource: { kind: "Function", name: "relay" },
    });
    const texts = children
      .filter((c) => c.type === "message")
      .map((c) => (c as { text: string }).text);
    assert.deepStrictEqual(texts, [
      `May sign: ${listing.signers}`,
      "Running version signed by key 0123…4567",
    ]);
  });
});
