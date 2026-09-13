import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as YAML from "yaml";
import { bundledSchemas } from "../manifests/schemas";
import { SchemaRegistry } from "../manifests/validate";
import {
  ResourcePanelController,
  disabledCopy,
  manifestToYaml,
  type ResourcePanelHost,
} from "../webview/controller";
import { deriveSpecFields, labelFor, readAt, writeAt } from "../webview/form";
import {
  RESOURCE_PANEL_VIEW_TYPE,
  cspNonce,
  openResourcePanel,
  panelHtml,
} from "../webview/panel";
import {
  emptyManifest,
  functionRoute,
  parseResourceStatus,
  parsePanelMessage,
  type ResourceCondition,
  type ResourceStatus,
  type HostMessage,
  type ManifestObject,
} from "../webview/protocol";
import type { Profile } from "../profiles/model";
import type { ManifestDeps } from "../manifests/diff";

const PROFILE: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

function functionSchema(): Record<string, unknown> {
  const entry = bundledSchemas().find((s) => s.kind === "Function");
  assert.ok(entry, "the Function schema must be bundled");
  return entry.schema as Record<string, unknown>;
}

function validManifest(name = "relay-to-op2"): ManifestObject {
  return {
    apiVersion: "airdress.co/v1alpha1",
    kind: "Function",
    metadata: { name },
    spec: {
      bundle: { path: "relay.tar.zst" },
      runtime: "wasm-component/v1",
      capabilities: { http: { hosts: ["op2.a.airdr.es"] } },
      limits: { cpuDeadlineMs: 5000, memoryMib: 128, concurrency: 8 },
      enabled: true,
    },
  };
}

const HEALTHY: ResourceStatus = {
  phase: "Healthy",
  conditions: [
    { type: "Loaded", status: "True" },
    { type: "Ready", status: "True" },
  ],
  bundleSha256: "ab".repeat(32),
  route: "/fn/relay-to-op2",
};

/** A recording fake host; every call is a line in `calls`. */
class FakeHost implements ResourcePanelHost {
  readonly calls: string[] = [];
  readonly posted: HostMessage[] = [];
  readonly profile = { label: PROFILE.label, fqdn: PROFILE.fqdn };
  manifest: ManifestObject = validManifest();
  status: ResourceStatus = HEALTHY;
  confirm = true;
  failManifest = false;
  failStatus = false;
  failDelete = false;
  closed = false;

  async fetchManifest(name: string): Promise<ManifestObject> {
    this.calls.push(`fetchManifest ${name}`);
    if (this.failManifest) {
      throw new Error("operator unreachable");
    }
    return structuredClone(this.manifest);
  }
  async fetchStatus(name: string): Promise<ResourceStatus> {
    this.calls.push(`fetchStatus ${name}`);
    if (this.failStatus) {
      throw new Error("status route missing");
    }
    return this.status;
  }
  async applyYaml(yaml: string): Promise<void> {
    this.calls.push(`applyYaml ${yaml.length}`);
    this.lastApplied = yaml;
    // The apply flow makes the manifest live; mirror that.
    this.manifest = YAML.parse(yaml) as ManifestObject;
  }
  lastApplied?: string;
  async diffYaml(yaml: string): Promise<void> {
    this.calls.push(`diffYaml ${yaml.length}`);
    this.lastDiffed = yaml;
  }
  lastDiffed?: string;
  async invoke(name: string, body: string) {
    this.calls.push(`invoke ${name} ${body}`);
    return { status: 200, body: `echo:${body}`, durationMs: 3 };
  }
  async confirmDelete(name: string): Promise<boolean> {
    this.calls.push(`confirmDelete ${name}`);
    return this.confirm;
  }
  async deleteResource(name: string): Promise<void> {
    this.calls.push(`deleteResource ${name}`);
    if (this.failDelete) {
      throw new Error("HTTP 409");
    }
  }
  post(message: HostMessage): void {
    this.posted.push(message);
  }
  close(): void {
    this.closed = true;
  }

  states(): Array<HostMessage & { type: "state" }> {
    return this.posted.filter(
      (m): m is HostMessage & { type: "state" } => m.type === "state",
    );
  }
  notices(): string[] {
    return this.posted
      .filter((m) => m.type === "notice")
      .map((m) => (m as { message: string }).message);
  }
  validations() {
    return this.posted.filter(
      (m): m is HostMessage & { type: "validation" } => m.type === "validation",
    );
  }
}

function controller(host: FakeHost, name?: string): ResourcePanelController {
  return new ResourcePanelController(host, {
    kind: "Function",
    name,
    schema: functionSchema(),
    registry: new SchemaRegistry(bundledSchemas()),
  });
}

suite("Function panel: state machine (fake host)", () => {
  test("load on an existing function fetches manifest then status and posts one state", async () => {
    const host = new FakeHost();
    await controller(host, "relay-to-op2").handle({ type: "load" });
    assert.deepStrictEqual(host.calls, [
      "fetchManifest relay-to-op2",
      "fetchStatus relay-to-op2",
    ]);
    const [state] = host.states();
    assert.strictEqual(state.mode, "existing");
    assert.deepStrictEqual(state.manifest, validManifest());
    assert.strictEqual(state.status?.phase, "Healthy");
    assert.strictEqual(state.loadError, undefined);
    assert.strictEqual(state.profile.fqdn, PROFILE.fqdn);
    assert.ok(state.schema?.properties, "the schema rides along for the form");
  });

  test("load on a draft posts an empty Function and touches no network", async () => {
    const host = new FakeHost();
    await controller(host).handle({ type: "load" });
    assert.deepStrictEqual(host.calls, []);
    const [state] = host.states();
    assert.strictEqual(state.mode, "new");
    assert.deepStrictEqual(
      state.manifest,
      emptyManifest("Function", "airdress.co/v1alpha1"),
    );
    assert.strictEqual(state.status, undefined);
  });

  test("an unreadable manifest still yields a form, with the failure worded", async () => {
    const host = new FakeHost();
    host.failManifest = true;
    await controller(host, "ghost").handle({ type: "load" });
    const [state] = host.states();
    assert.strictEqual(state.mode, "existing");
    assert.match(state.loadError ?? "", /Function\/ghost/);
    assert.match(state.loadError ?? "", /operator unreachable/);
    assert.strictEqual(
      (state.manifest.metadata as { name: string }).name,
      "ghost",
    );
    // Status is not asked for when the manifest is missing.
    assert.deepStrictEqual(host.calls, ["fetchManifest ghost"]);
  });

  test("a failing status route degrades to no status, not to no panel", async () => {
    const host = new FakeHost();
    host.failStatus = true;
    await controller(host, "relay-to-op2").handle({ type: "load" });
    const [state] = host.states();
    assert.strictEqual(state.status, undefined);
    assert.match(state.loadError ?? "", /Status .* unavailable/);
    assert.deepStrictEqual(state.manifest, validManifest());
  });

  test("validate posts the registry's diagnostics for the manifest, and a nameless draft is named as the problem", async () => {
    const host = new FakeHost();
    const c = controller(host);
    await c.handle({ type: "validate", manifest: validManifest() });
    assert.deepStrictEqual(host.validations()[0].diagnostics, []);

    const bad = validManifest("");
    (bad.spec as Record<string, unknown>).limits = { memoryMib: 1 };
    await c.handle({ type: "validate", manifest: bad });
    const diagnostics = host.validations()[1].diagnostics;
    assert.ok(diagnostics.some((d) => d.path === "/metadata/name"));
    assert.ok(diagnostics.some((d) => d.path === "/spec/limits/memoryMib"));
  });

  test("apply with an invalid manifest never reaches the apply flow", async () => {
    const host = new FakeHost();
    const bad = validManifest();
    (bad.spec as Record<string, unknown>).bundle = { path: "../escape" };
    await controller(host, "relay-to-op2").handle({
      type: "apply",
      manifest: bad,
    });
    assert.ok(!host.calls.some((c) => c.startsWith("applyYaml")));
    assert.ok(host.validations()[0].diagnostics.length > 0);
    assert.ok(host.notices().some((n) => /fails schema validation/.test(n)));
  });

  test("apply with a valid manifest hands YAML to the existing flow, then reloads from the operator", async () => {
    const host = new FakeHost();
    const manifest = validManifest();
    (manifest.spec as Record<string, unknown>).limits = { concurrency: 2 };
    await controller(host, "relay-to-op2").handle({ type: "apply", manifest });
    assert.ok(host.calls.some((c) => c.startsWith("applyYaml")));
    assert.deepStrictEqual(YAML.parse(host.lastApplied ?? ""), manifest);
    // Reload AFTER the apply: the panel shows what the operator holds.
    const applyIndex = host.calls.findIndex((c) => c.startsWith("applyYaml"));
    assert.ok(
      host.calls.indexOf("fetchManifest relay-to-op2") > applyIndex,
      "the reload must follow the apply",
    );
    const state = host.states().at(-1);
    assert.deepStrictEqual(state?.manifest, manifest);
  });

  test("apply of a draft binds the panel to the new name", async () => {
    const host = new FakeHost();
    const c = controller(host);
    assert.strictEqual(c.name, undefined);
    await c.handle({ type: "apply", manifest: validManifest("fresh") });
    assert.strictEqual(c.name, "fresh");
    assert.ok(host.calls.includes("fetchManifest fresh"));
  });

  test("renaming an existing function through the panel is refused, not applied", async () => {
    const host = new FakeHost();
    await controller(host, "relay-to-op2").handle({
      type: "apply",
      manifest: validManifest("something-else"),
    });
    assert.ok(!host.calls.some((c) => c.startsWith("applyYaml")));
    assert.ok(host.notices().some((n) => /different name/.test(n)));
  });

  test("disable applies a copy with enabled: false and leaves the rest alone", async () => {
    const host = new FakeHost();
    await controller(host, "relay-to-op2").handle({
      type: "disable",
      manifest: validManifest(),
    });
    const applied = YAML.parse(host.lastApplied ?? "") as ManifestObject;
    assert.strictEqual((applied.spec as { enabled: boolean }).enabled, false);
    const expected = validManifest();
    (expected.spec as Record<string, unknown>).enabled = false;
    assert.deepStrictEqual(applied, expected);
    assert.deepStrictEqual(disabledCopy({ kind: "Function" }).spec, {
      enabled: false,
    });
  });

  test("diff hands the current manifest as YAML to the existing diff flow", async () => {
    const host = new FakeHost();
    const manifest = validManifest();
    await controller(host, "relay-to-op2").handle({ type: "diff", manifest });
    assert.strictEqual(host.lastDiffed, manifestToYaml(manifest));
    assert.ok(!host.calls.some((c) => c.startsWith("applyYaml")));
  });

  test("invoke posts the function's answer; a draft cannot be invoked", async () => {
    const host = new FakeHost();
    await controller(host, "relay-to-op2").handle({
      type: "invoke",
      body: '{"a":1}',
    });
    assert.ok(host.calls.includes('invoke relay-to-op2 {"a":1}'));
    const result = host.posted.find((m) => m.type === "invocation");
    assert.ok(result && result.type === "invocation");
    assert.strictEqual(result.result.status, 200);
    assert.strictEqual(result.result.body, 'echo:{"a":1}');

    const draftHost = new FakeHost();
    await controller(draftHost).handle({ type: "invoke", body: "x" });
    assert.deepStrictEqual(draftHost.calls, []);
    assert.ok(draftHost.notices().some((n) => /apply the function/i.test(n)));
  });

  test("delete asks first; a declined confirm issues nothing", async () => {
    const host = new FakeHost();
    host.confirm = false;
    await controller(host, "relay-to-op2").handle({ type: "delete" });
    assert.deepStrictEqual(host.calls, ["confirmDelete relay-to-op2"]);
    assert.strictEqual(host.closed, false);
  });

  test("a confirmed delete issues the request, names the route that stopped, and closes", async () => {
    const host = new FakeHost();
    await controller(host, "relay-to-op2").handle({ type: "delete" });
    assert.deepStrictEqual(host.calls, [
      "confirmDelete relay-to-op2",
      "deleteResource relay-to-op2",
    ]);
    assert.ok(
      host.notices().some((n) => n.includes(functionRoute("relay-to-op2"))),
    );
    assert.ok(host.posted.some((m) => m.type === "closed"));
    assert.strictEqual(host.closed, true);
  });

  test("a failed delete is reported and the panel stays open", async () => {
    const host = new FakeHost();
    host.failDelete = true;
    await controller(host, "relay-to-op2").handle({ type: "delete" });
    assert.ok(host.notices().some((n) => /deleting .* failed/.test(n)));
    assert.strictEqual(host.closed, false);
  });

  test("a malformed message is dropped with an error notice and no host call", async () => {
    const host = new FakeHost();
    const c = controller(host, "relay-to-op2");
    for (const raw of [
      null,
      "apply",
      { type: "apply" },
      { type: "apply", manifest: "kind: Function" },
      { type: "invoke", body: 42 },
      { type: "explode" },
    ]) {
      await c.handle(raw);
    }
    assert.deepStrictEqual(host.calls, []);
    assert.strictEqual(
      host.notices().filter((n) => /does not understand/.test(n)).length,
      6,
    );
  });

  test("every handled message ends by clearing the busy marker", async () => {
    const host = new FakeHost();
    await controller(host, "relay-to-op2").handle({ type: "load" });
    assert.deepStrictEqual(host.posted.at(-1), {
      type: "busy",
      what: undefined,
    });
  });
});

suite("Function panel: message shapes", () => {
  test("accepts exactly the protocol's forms", () => {
    const manifest = validManifest();
    assert.deepStrictEqual(parsePanelMessage({ type: "load" }), {
      type: "load",
    });
    assert.deepStrictEqual(parsePanelMessage({ type: "delete" }), {
      type: "delete",
    });
    for (const type of ["validate", "apply", "diff", "disable"] as const) {
      assert.deepStrictEqual(parsePanelMessage({ type, manifest }), {
        type,
        manifest,
      });
    }
    assert.deepStrictEqual(parsePanelMessage({ type: "invoke", body: "" }), {
      type: "invoke",
      body: "",
    });
  });

  test("rejects anything that is not exactly a protocol form", () => {
    for (const raw of [
      undefined,
      null,
      7,
      "load",
      [],
      {},
      { type: 3 },
      { type: "LOAD" },
      { type: "apply" },
      { type: "apply", manifest: null },
      { type: "apply", manifest: [] },
      { type: "apply", manifest: { kind: "Function" } },
      { type: "apply", manifest: { kind: "Function", metadata: {} } },
      { type: "apply", manifest: { metadata: { name: "x" } } },
      { type: "invoke" },
      { type: "invoke", body: { a: 1 } },
      { type: "state" },
    ]) {
      assert.strictEqual(
        parsePanelMessage(raw),
        undefined,
        JSON.stringify(raw),
      );
    }
  });

  test("status decoding never invents health", () => {
    assert.strictEqual(parseResourceStatus(undefined).phase, "Unknown");
    assert.strictEqual(
      parseResourceStatus({ phase: "healthy" }).phase,
      "Unknown",
    );
    const decoded = parseResourceStatus({
      phase: "Failed",
      conditions: [
        { type: "Loaded", status: "False", reason: "DigestMismatch" },
        { status: "True" },
        { type: "Ready", status: true },
        { type: "Odd", status: "maybe" },
      ],
      bundle_sha256: "cd".repeat(32),
      last_error: "sha256 differs",
    });
    assert.strictEqual(decoded.phase, "Failed");
    assert.deepStrictEqual(
      decoded.conditions.map((c: ResourceCondition) => `${c.type}=${c.status}`),
      ["Loaded=False", "Ready=True", "Odd=Unknown"],
    );
    assert.strictEqual(decoded.conditions[0].reason, "DigestMismatch");
    assert.strictEqual(decoded.bundleSha256, "cd".repeat(32));
    assert.strictEqual(decoded.lastError, "sha256 differs");
  });
});

suite("Function panel: form derived from the bundled schema", () => {
  const fields = deriveSpecFields(functionSchema());
  const at = (p: string) => fields.find((f) => f.path.join(".") === p);

  test("every editable leaf of spec becomes a field, grouped by its top-level key", () => {
    const paths = fields.map((f) => f.path.join("."));
    for (const expected of [
      "bundle.path",
      "bundle.sha256",
      "bundle.signer",
      "runtime",
      "capabilities.http.hosts",
      "limits.cpuDeadlineMs",
      "limits.memoryMib",
      "limits.concurrency",
      "enabled",
    ]) {
      assert.ok(paths.includes(expected), `missing field ${expected}`);
    }
    assert.strictEqual(at("limits.memoryMib")?.group, "limits");
    assert.strictEqual(at("capabilities.http.hosts")?.group, "capabilities");
  });

  test("constraints ride along: required, pattern, min/max, enum, default", () => {
    const bundlePath = at("bundle.path");
    assert.strictEqual(bundlePath?.kind, "string");
    assert.strictEqual(bundlePath?.required, true);
    assert.ok(bundlePath?.pattern);
    assert.strictEqual(at("bundle.sha256")?.required, false);
    assert.strictEqual(at("bundle.sha256")?.nullable, true);

    const memory = at("limits.memoryMib");
    assert.strictEqual(memory?.kind, "integer");
    // schemars stamps `format: uint32` beside the bounds; min/max must
    // be read regardless of the format keyword.
    assert.strictEqual(memory?.minimum, 16);
    assert.strictEqual(memory?.maximum, 512);
    // The published schema carries no JSON `default` on the limits —
    // the default ("128") lives in the description and is applied by
    // the operator, not the manifest.
    assert.strictEqual(memory?.default, undefined);
    // limits itself is optional, so its leaves are never "required".
    assert.strictEqual(memory?.required, false);

    // `runtime` is a plain string in the published schema (the sole
    // accepted tier is enforced by the operator, not the schema), so it
    // derives as a string field rather than a one-value enum.
    const runtime = at("runtime");
    assert.strictEqual(runtime?.kind, "string");
    assert.strictEqual(runtime?.default, "wasm-component/v1");

    // enum derivation still works where the schema actually declares one.
    const enumFields = deriveSpecFields({
      properties: {
        spec: {
          type: "object",
          properties: { tier: { type: "string", enum: ["a", "b"] } },
        },
      },
    });
    assert.strictEqual(enumFields[0]?.kind, "enum");
    assert.deepStrictEqual(enumFields[0]?.enum, ["a", "b"]);

    assert.strictEqual(at("enabled")?.kind, "boolean");
    assert.strictEqual(at("enabled")?.default, true);
  });

  test("http hosts is a string list; a world with no shape is opaque, so the form draws it disabled", () => {
    const hosts = at("capabilities.http.hosts");
    assert.strictEqual(hosts?.kind, "string-list");
    assert.ok(hosts?.pattern, "the no-wildcard pattern reaches the items");

    // `identity` and `log` are empty objects in the published schema —
    // no inner shape — so they derive as a single opaque field the form
    // draws disabled ("not yet available on this operator").
    for (const world of ["identity", "log"]) {
      assert.strictEqual(
        at(`capabilities.${world}`)?.kind,
        "opaque",
        `${world} must be opaque`,
      );
    }

    // `kv`, `inbox` and `llm` DO carry inner shape now, so the walker
    // descends into them rather than drawing one opaque box — the form
    // follows the schema. Each world's own leaves become fields.
    for (const world of ["kv", "inbox", "llm"]) {
      assert.strictEqual(
        at(`capabilities.${world}`),
        undefined,
        `${world} has a shape, so it is not a single opaque field`,
      );
    }
    assert.strictEqual(at("capabilities.kv.maxBytes")?.kind, "integer");
    assert.strictEqual(at("capabilities.kv.namespace")?.kind, "string");
    assert.strictEqual(at("capabilities.inbox.topics")?.kind, "string-list");
    assert.strictEqual(at("capabilities.llm.models")?.kind, "string-list");
    assert.strictEqual(at("capabilities.llm.providers")?.kind, "string-list");
  });

  test("a capability world written as an anyOf-nullable wrapper is seen through", () => {
    // schemars can emit an Option<World> as anyOf: [ <object>, {null} ]
    // rather than type: [object, null]. The walker must collapse that
    // to the shaped branch: http.hosts is still found as a string list,
    // and an empty-object world is still opaque.
    const derived = deriveSpecFields({
      properties: {
        spec: {
          type: "object",
          properties: {
            capabilities: {
              type: "object",
              properties: {
                http: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        hosts: {
                          type: "array",
                          items: { type: "string", pattern: "^[^*\\s]+$" },
                        },
                      },
                    },
                    { type: "null" },
                  ],
                },
                log: {
                  anyOf: [{ type: "object" }, { type: "null" }],
                },
              },
            },
          },
        },
      },
    });
    const by = (p: string) => derived.find((f) => f.path.join(".") === p);
    assert.strictEqual(by("capabilities.http.hosts")?.kind, "string-list");
    assert.ok(by("capabilities.http.hosts")?.pattern);
    assert.strictEqual(by("capabilities.log")?.kind, "opaque");
    assert.strictEqual(by("capabilities.log")?.nullable, true);
  });

  test("the derivation follows the schema, not a hard-coded list", () => {
    const moved = structuredClone(functionSchema()) as {
      properties: { spec: { properties: Record<string, unknown> } };
    };
    moved.properties.spec.properties.timeoutMs = {
      type: "integer",
      minimum: 1,
    };
    delete moved.properties.spec.properties.limits;
    const derived = deriveSpecFields(moved).map((f) => f.path.join("."));
    assert.ok(derived.includes("timeoutMs"));
    assert.ok(!derived.some((p) => p.startsWith("limits")));
    assert.deepStrictEqual(deriveSpecFields({}), []);
  });

  test("labels and path helpers", () => {
    assert.strictEqual(labelFor("cpuDeadlineMs"), "Cpu deadline ms");
    assert.strictEqual(labelFor("sha256"), "Sha256");
    const spec: Record<string, unknown> = {};
    writeAt(spec, ["limits", "memoryMib"], 64);
    assert.deepStrictEqual(spec, { limits: { memoryMib: 64 } });
    assert.strictEqual(readAt(spec, ["limits", "memoryMib"]), 64);
    assert.strictEqual(readAt(spec, ["limits", "nope"]), undefined);
    writeAt(spec, ["limits", "memoryMib"], undefined);
    assert.deepStrictEqual(spec, {}, "an emptied object is pruned");
  });
});

suite("Function panel: contributions and shell", () => {
  function pkg() {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    return {
      root: ext.extensionPath,
      pkg: JSON.parse(
        fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
      ) as {
        contributes: {
          commands: Array<{ command: string; title: string }>;
          menus: Record<string, Array<{ command: string; when?: string }>>;
        };
      },
    };
  }

  test("configure is hidden from the palette and contributed only against Function rows", () => {
    const { pkg: p } = pkg();
    const palette = p.contributes.menus.commandPalette.find(
      (m) => m.command === "airdress.functions.configure",
    );
    assert.strictEqual(palette?.when, "false");
    const items = p.contributes.menus["view/item/context"].filter(
      (m) => m.command === "airdress.functions.configure",
    );
    assert.ok(items.length >= 1);
    for (const item of items) {
      assert.ok(
        /viewItem == airdressResource\.Function/.test(item.when ?? ""),
        "the gear must target Function rows only",
      );
      assert.ok(/view == airdress\.resources/.test(item.when ?? ""));
    }
    assert.ok(
      p.contributes.commands.some(
        (c) => c.command === "airdress.functions.new",
      ),
    );
    assert.ok(
      !p.contributes.menus.commandPalette.some(
        (m) => m.command === "airdress.functions.new",
      ),
      "New Function stays in the palette",
    );
  });

  test("the browser bundle ships, imports no vscode module, and the CSS is one file", () => {
    const { root } = pkg();
    const bundle = fs.readFileSync(
      path.join(root, "dist", "webview.js"),
      "utf8",
    );
    assert.ok(!/require\(["']vscode["']\)/.test(bundle));
    assert.ok(bundle.includes("acquireVsCodeApi"));
    assert.ok(fs.existsSync(path.join(root, "media", "function-panel.css")));
  });

  test("the shell carries a strict CSP with a nonce'd script and no inline allowances", () => {
    const { root } = pkg();
    const panel = vscode.window.createWebviewPanel(
      RESOURCE_PANEL_VIEW_TYPE,
      "csp test",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    try {
      const nonce = cspNonce();
      const html = panelHtml(panel.webview, vscode.Uri.file(root), nonce);
      const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
      assert.ok(csp);
      assert.ok(csp.includes("default-src 'none'"));
      assert.ok(csp.includes(`script-src 'nonce-${nonce}'`));
      assert.ok(!csp.includes("unsafe-inline"));
      assert.ok(!csp.includes("unsafe-eval"));
      // Stylesheet and fonts come from the webview's OWN origin, nothing
      // else; scripts from nowhere but the nonce.
      assert.ok(csp.includes(`style-src ${panel.webview.cspSource}`));
      assert.ok(csp.includes(`font-src ${panel.webview.cspSource}`));
      const directives = csp.split(";").map((d) => d.trim());
      assert.strictEqual(
        directives.find((d) => d.startsWith("script-src")),
        `script-src 'nonce-${nonce}'`,
      );
      assert.ok(!directives.some((d) => d.startsWith("connect-src")));
      assert.strictEqual(
        (html.match(/<script/g) ?? []).length,
        1,
        "exactly one script tag",
      );
      assert.ok(html.includes(`<script nonce="${nonce}"`));
      assert.ok(html.includes("function-panel.css"));
      assert.ok(html.includes("webview.js"));
    } finally {
      panel.dispose();
    }
  });

  test("opening the same function twice reveals one panel; a draft is its own", async () => {
    const { root } = pkg();
    const host = new FakeHost();
    const deps = {
      manifest: {} as ManifestDeps,
      extensionUri: vscode.Uri.file(root),
      hostFor: () => host,
    };
    const first = await openResourcePanel(
      deps,
      PROFILE,
      "Function",
      "relay-to-op2",
    );
    const again = await openResourcePanel(
      deps,
      PROFILE,
      "Function",
      "relay-to-op2",
    );
    const draft = await openResourcePanel(deps, PROFILE, "Function", undefined);
    try {
      assert.strictEqual(first, again);
      assert.notStrictEqual(first, draft);
      assert.strictEqual(first.viewType, RESOURCE_PANEL_VIEW_TYPE);
      assert.strictEqual(first.title, "Function: relay-to-op2");
      assert.strictEqual(draft.title, "New Function");
    } finally {
      first.dispose();
      draft.dispose();
    }
    // Disposed panels are forgotten: the next open is a fresh one.
    const fresh = await openResourcePanel(
      deps,
      PROFILE,
      "Function",
      "relay-to-op2",
    );
    assert.notStrictEqual(fresh, first);
    fresh.dispose();
  });
});
