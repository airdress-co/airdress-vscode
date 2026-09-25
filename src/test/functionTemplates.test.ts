import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as YAML from "yaml";
import { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import {
  canonicalDigestString,
  CHECKOUT_FILE,
  signingKeyFromSeedText,
} from "../functions/local";
import {
  capabilitiesSuggestion,
  configEntries,
  forkFiles,
  GRANT_EXPLANATION,
  manifestDraft,
} from "../functions/templates";
import {
  createFromTemplate,
  forkTemplate,
  signerNaming,
  type TemplateDeps,
  type TemplateUI,
} from "../functions/templateFlows";
import {
  defaultFunctionId,
  parseTemplatePanelMessage,
} from "../functions/templateProtocol";
import type { Template, TemplateField } from "../functions/wire";

const PROFILE: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

const VERSION = `sha256:${"3".repeat(64)}`;

/** The webhook-relay template, as the operator serves it. */
const RELAY: Template = {
  id: "webhook-relay",
  title: "Relay a webhook to another operator",
  description: "Forwards each request's body to a peer.",
  entry: "src/main.ts",
  requires: { http: { hostsRequired: true } },
  config: {
    fields: [
      { name: "target", type: "string", description: "The peer URL." },
      {
        name: "token",
        type: "secret",
        required: true,
        description: "The peer's bearer.",
      },
      { name: "timeoutMs", type: "number", default: 3000, description: "ms" },
      { name: "verbose", type: "boolean", description: "log more" },
    ],
  },
  files: {
    "function.json":
      '{\n  "id": "example.function",\n  "entry": "src/main.ts",\n  "runtime": "js-source/v1",\n  "capabilities": [{ "name": "airdress:fn/http@0.1.0" }]\n}\n',
    "src/main.ts":
      "export default async (req: Request) => new Response('ok');\n",
  },
};

class FakeUI implements TemplateUI {
  readonly drafts: string[] = [];
  readonly opened: vscode.Uri[] = [];
  constructor(
    private readonly folder?: vscode.Uri,
    private readonly confirmAnswer = true,
  ) {}
  confirm() {
    return Promise.resolve(this.confirmAnswer);
  }
  pickFolder() {
    return Promise.resolve(this.folder);
  }
  open(uri: vscode.Uri) {
    this.opened.push(uri);
    return Promise.resolve();
  }
  openDraft(yaml: string) {
    this.drafts.push(yaml);
    return Promise.resolve();
  }
  copy() {
    return Promise.resolve();
  }
  pick<T>(items: T[]) {
    return Promise.resolve(items[0]);
  }
  error() {}
}

/** The template as the operator serves it for `functionId`. */
function servedFor(functionId: string | null): Template {
  if (!functionId) {
    return RELAY;
  }
  return {
    ...RELAY,
    files: {
      ...RELAY.files,
      "function.json": RELAY.files["function.json"].replace(
        '"id": "example.function"',
        `"id": "${functionId}"`,
      ),
    },
  };
}

function depsWith(
  ui: TemplateUI,
  calls: Array<{ method: string; url: string; body: unknown }>,
  seed?: string,
  opts: { digest?: (tree: Map<string, Uint8Array>) => string } = {},
): TemplateDeps {
  const client = new ApiClient({
    baseUrl: "https://ada.a.airdr.es",
    getToken: async () => "bearer-1",
    fetchFn: (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const sent = JSON.parse(String(init?.body ?? "null")) as {
        files?: Array<{ path: string; contentBase64: string }>;
      } | null;
      calls.push({ method, url: String(input), body: sent });
      let body: unknown;
      if (method === "GET") {
        body = servedFor(url.searchParams.get("functionId"));
      } else {
        const tree = new Map(
          (sent?.files ?? []).map((f) => [
            f.path,
            new Uint8Array(Buffer.from(f.contentBase64, "base64")),
          ]),
        );
        const dryRun = url.searchParams.get("dry-run") === "true";
        body = {
          version: VERSION,
          name: "relay",
          files: [],
          entry: "src/main.ts",
          sourceDigest: (opts.digest ?? canonicalDigestString)(tree),
          unreachable: [],
          warnings: dryRun
            ? ["the tree is unsigned: checked, not verified."]
            : [],
          dryRun,
          created: !dryRun,
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    }) as typeof fetch,
  });
  return {
    client: () => client,
    signing: async () => (seed ? { key: signingKeyFromSeedText(seed) } : {}),
    ui,
  };
}

suite("templates: the config form becomes spec.config", () => {
  const fields = RELAY.config.fields;

  test("each type lands as its own JSON type; empty fields are left out", () => {
    const r = configEntries(fields, {
      target: "https://peer.example/ingest",
      token: "peer-token",
      timeoutMs: "2500",
      verbose: true,
    });
    assert.deepStrictEqual(r.missing, []);
    assert.deepStrictEqual(r.entries, [
      { name: "target", value: "https://peer.example/ingest" },
      { name: "token", valueFrom: { secretRef: "peer-token" } },
      { name: "timeoutMs", value: 2500 },
      { name: "verbose", value: true },
    ]);
    assert.deepStrictEqual(
      configEntries(fields, { token: "t", target: "  " }).entries,
      [{ name: "token", valueFrom: { secretRef: "t" } }],
    );
  });

  test("a secret field never produces an inline value", () => {
    const secretOnly: TemplateField[] = [
      { name: "apiKey", type: "secret", description: "" },
    ];
    for (const v of ["plain-looking", "sk_live_123", "  spaced  "]) {
      const [entry] = configEntries(secretOnly, { apiKey: v }).entries;
      assert.ok(!("value" in entry), JSON.stringify(entry));
      assert.deepStrictEqual(entry, {
        name: "apiKey",
        valueFrom: { secretRef: v.trim() },
      });
    }
  });

  test("a required field left empty and a non-number are named, not guessed", () => {
    const r = configEntries(fields, { timeoutMs: "soon" });
    assert.deepStrictEqual(r.missing, ["token"]);
    assert.strictEqual(r.invalid.length, 1);
    assert.match(r.invalid[0], /timeoutMs/);
  });

  test("the draft's spec.config is the form's entries, as YAML", () => {
    const draft = manifestDraft({
      name: "relay",
      version: VERSION,
      signer: { signer: "ab".repeat(32) },
      config: configEntries(fields, { token: "peer-token", target: "x" })
        .entries,
      requires: {},
    });
    const doc = YAML.parse(draft) as {
      spec: { config: unknown[]; source: unknown; runtime: string };
    };
    assert.deepStrictEqual(doc.spec.config, [
      { name: "target", value: "x" },
      { name: "token", valueFrom: { secretRef: "peer-token" } },
    ]);
    assert.deepStrictEqual(doc.spec.source, {
      version: VERSION,
      signer: "ab".repeat(32),
    });
    assert.strictEqual(doc.spec.runtime, "js-source/v1");
  });
});

suite("templates: requires is shown as YAML, never written", () => {
  test("each required world becomes a capabilities entry; hosts are left for the owner", () => {
    const yaml = capabilitiesSuggestion({
      http: { hostsRequired: true },
      kv: {},
      log: {},
    });
    const doc = YAML.parse(yaml) as {
      spec: { capabilities: Record<string, unknown> };
    };
    assert.deepStrictEqual(Object.keys(doc.spec.capabilities), [
      "http",
      "log",
      "kv",
    ]);
    assert.deepStrictEqual(doc.spec.capabilities.http, { hosts: [] });
    assert.match(yaml, /the template cannot know them/);
    assert.strictEqual(capabilitiesSuggestion({}), "");
  });

  test("the draft carries the grant only as comments, with the reason", () => {
    const draft = manifestDraft({
      name: "relay",
      version: VERSION,
      signer: {},
      config: [],
      requires: RELAY.requires,
    });
    const doc = YAML.parse(draft) as { spec: Record<string, unknown> };
    assert.ok(!("capabilities" in doc.spec), "the draft must not grant");
    assert.match(
      draft,
      /^# This function needs grants the form did not write\./,
    );
    assert.match(draft, /^#\s+capabilities:$/m);
    assert.match(draft, /the operator refuses a publish/);
    assert.match(GRANT_EXPLANATION, /owner's decision/);
  });

  test("publishing from the form sends a body with no grant, and drafts a manifest without one", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const ui = new FakeUI();
    const result = await createFromTemplate(
      depsWith(ui, calls, "cd".repeat(32)),
      PROFILE,
      RELAY,
      "relay",
      "com.example.relay",
      { token: "peer-token" },
    );
    assert.ok(result.ok, result.message);
    assert.deepStrictEqual(
      calls.map(
        (c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`,
      ),
      [
        "GET /v1/functions/templates/webhook-relay?functionId=com.example.relay",
        "POST /v1/functions/sources?dry-run=true",
        "POST /v1/functions/sources",
      ],
    );
    assert.ok(
      !("signature" in (calls[1].body as object)),
      "the check is unsigned",
    );
    const body = calls[2].body as Record<string, unknown>;
    assert.ok(typeof body.signature === "string", "the publish is signed");
    const manifest = Buffer.from(
      (body.files as Array<{ path: string; contentBase64: string }>)[0]
        .contentBase64,
      "base64",
    ).toString("utf8");
    assert.strictEqual(
      manifest,
      servedFor("com.example.relay").files["function.json"],
      "function.json is published as the operator served it for the id",
    );
    assert.ok(!("capabilities" in body));
    assert.ok(!("spec" in body));
    assert.strictEqual(body.basedOn, undefined, "a new function has no base");
    assert.deepStrictEqual(
      (body.files as Array<{ path: string }>).map((f) => f.path),
      ["function.json", "src/main.ts"],
    );
    const doc = YAML.parse(ui.drafts[0]) as {
      spec: { capabilities?: unknown; config: unknown; source: unknown };
    };
    assert.strictEqual(doc.spec.capabilities, undefined);
    assert.deepStrictEqual(doc.spec.config, [
      { name: "token", valueFrom: { secretRef: "peer-token" } },
    ]);
    assert.deepStrictEqual(doc.spec.source, {
      version: VERSION,
      ...signerNaming({ key: signingKeyFromSeedText("cd".repeat(32)) }),
    });
  });

  test("a digest the operator disagrees with stops before signing or storing", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const ui = new FakeUI();
    const result = await createFromTemplate(
      depsWith(ui, calls, "cd".repeat(32), {
        digest: () => `sha256:${"0".repeat(64)}`,
      }),
      PROFILE,
      RELAY,
      "relay",
      "relay",
      { token: "t" },
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /nothing was signed/);
    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["GET", "POST"],
    );
    assert.strictEqual(ui.drafts.length, 0);
  });

  test("a required field left empty stops before any request", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const result = await createFromTemplate(
      depsWith(new FakeUI(), calls),
      PROFILE,
      RELAY,
      "relay",
      "relay",
      {},
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /token/);
    assert.strictEqual(calls.length, 0);
  });
});

suite("templates: forking writes ordinary source", () => {
  function listAll(dir: string, prefix = ""): string[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? listAll(path.join(dir, e.name), `${prefix}${e.name}/`)
          : [`${prefix}${e.name}`],
      );
  }

  test("the template's files, byte for byte, and nothing else", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airdress-fork-"));
    const ui = new FakeUI(vscode.Uri.file(dir));
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const result = await forkTemplate(
      depsWith(ui, calls),
      PROFILE,
      RELAY,
      "com.example.relay",
    );
    assert.ok(result.ok, result.message);
    assert.ok(calls[0].url.endsWith("?functionId=com.example.relay"));
    const served = servedFor("com.example.relay");
    assert.deepStrictEqual(
      listAll(dir).sort(),
      Object.keys(served.files).sort(),
    );
    assert.ok(!served.files["function.json"].includes("example.function"));
    for (const [p, content] of Object.entries(served.files)) {
      assert.strictEqual(fs.readFileSync(path.join(dir, p), "utf8"), content);
    }
    assert.ok(!fs.existsSync(path.join(dir, CHECKOUT_FILE)));
    for (const p of listAll(dir)) {
      assert.ok(
        !fs.readFileSync(path.join(dir, p), "utf8").includes(RELAY.id) ||
          served.files[p].includes(RELAY.id),
        `${p} gained a reference to the template`,
      );
    }
    assert.strictEqual(ui.opened[0].fsPath, path.join(dir, "src", "main.ts"));
  });

  test("a folder that already holds a tree is refused, untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airdress-fork-"));
    fs.writeFileSync(path.join(dir, "function.json"), "{}");
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const result = await forkTemplate(
      depsWith(new FakeUI(vscode.Uri.file(dir)), calls),
      PROFILE,
      RELAY,
      "relay",
    );
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(listAll(dir), ["function.json"]);
    assert.strictEqual(
      fs.readFileSync(path.join(dir, "function.json"), "utf8"),
      "{}",
    );
  });

  test("an unsafe path in a template is refused rather than written", () => {
    assert.throws(() => forkFiles({ "../escape.ts": "x" }), /unsafe path/);
    assert.throws(() => forkFiles({ "/abs.ts": "x" }), /unsafe path/);
  });
});

suite("templates: panel messages", () => {
  test("well-formed messages parse; anything else is dropped", () => {
    assert.deepStrictEqual(
      parseTemplatePanelMessage({
        type: "create",
        name: "relay",
        functionId: "com.example.relay",
        values: { a: "1", b: true, c: 3 },
      }),
      {
        type: "create",
        name: "relay",
        functionId: "com.example.relay",
        values: { a: "1", b: true },
      },
    );
    assert.deepStrictEqual(
      parseTemplatePanelMessage({ type: "fork", functionId: "x" }),
      { type: "fork", functionId: "x" },
    );
    assert.strictEqual(parseTemplatePanelMessage({ type: "fork" }), undefined);
    assert.strictEqual(defaultFunctionId("relay-to-op2"), "relay-to-op2");
    assert.strictEqual(defaultFunctionId(" a b "), "a-b");
    assert.strictEqual(parseTemplatePanelMessage({ type: "grant" }), undefined);
    assert.strictEqual(parseTemplatePanelMessage("fork"), undefined);
  });
});
