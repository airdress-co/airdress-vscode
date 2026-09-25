import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as YAML from "yaml";
import { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import { CHECKOUT_FILE, signingKeyFromSeedText } from "../functions/local";
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
import { parseTemplatePanelMessage } from "../functions/templateProtocol";
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
      '{"entry":"src/main.ts","runtime":"js-source/v1","capabilities":[{"name":"airdress:fn/http@0.1.0"}]}\n',
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

function depsWith(
  ui: TemplateUI,
  calls: Array<{ url: string; body: unknown }>,
  seed?: string,
): TemplateDeps {
  const client = new ApiClient({
    baseUrl: "https://ada.a.airdr.es",
    getToken: async () => "bearer-1",
    fetchFn: (async (input: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      const body = {
        version: VERSION,
        name: "relay",
        files: [],
        entry: "src/main.ts",
        unreachable: [],
        warnings: [],
        dryRun: false,
        created: true,
      };
      return {
        ok: true,
        status: 201,
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
    const calls: Array<{ url: string; body: unknown }> = [];
    const ui = new FakeUI();
    const result = await createFromTemplate(
      depsWith(ui, calls, "cd".repeat(32)),
      PROFILE,
      RELAY,
      "relay",
      { token: "peer-token" },
    );
    assert.ok(result.ok, result.message);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/v1/functions/sources"));
    const body = calls[0].body as Record<string, unknown>;
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

  test("a required field left empty stops before any request", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await createFromTemplate(
      depsWith(new FakeUI(), calls),
      PROFILE,
      RELAY,
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
    const result = await forkTemplate(depsWith(ui, []), RELAY);
    assert.ok(result.ok, result.message);
    assert.deepStrictEqual(
      listAll(dir).sort(),
      Object.keys(RELAY.files).sort(),
    );
    for (const [p, content] of Object.entries(RELAY.files)) {
      assert.strictEqual(fs.readFileSync(path.join(dir, p), "utf8"), content);
    }
    assert.ok(!fs.existsSync(path.join(dir, CHECKOUT_FILE)));
    for (const p of listAll(dir)) {
      assert.ok(
        !fs.readFileSync(path.join(dir, p), "utf8").includes(RELAY.id) ||
          RELAY.files[p].includes(RELAY.id),
        `${p} gained a reference to the template`,
      );
    }
    assert.strictEqual(ui.opened[0].fsPath, path.join(dir, "src", "main.ts"));
  });

  test("a folder that already holds a tree is refused, untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airdress-fork-"));
    fs.writeFileSync(path.join(dir, "function.json"), "{}");
    const result = await forkTemplate(
      depsWith(new FakeUI(vscode.Uri.file(dir)), []),
      RELAY,
    );
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
        values: { a: "1", b: true, c: 3 },
      }),
      { type: "create", name: "relay", values: { a: "1", b: true } },
    );
    assert.deepStrictEqual(parseTemplatePanelMessage({ type: "fork" }), {
      type: "fork",
    });
    assert.strictEqual(parseTemplatePanelMessage({ type: "grant" }), undefined);
    assert.strictEqual(parseTemplatePanelMessage("fork"), undefined);
  });
});
