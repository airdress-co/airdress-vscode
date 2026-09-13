import * as assert from "assert";
import * as YAML from "yaml";
import { bundledSchemas } from "../manifests/schemas";
import { SchemaRegistry } from "../manifests/validate";
import {
  ResourcePanelController,
  isConflict,
  readResourceVersion,
  stripVersion,
  type ResourcePanelHost,
} from "../webview/controller";
import { deriveSpecFields } from "../webview/form";
import { capabilitiesFor, hasFunctionExtras } from "../webview/kinds";
import {
  emptyManifest,
  type HostMessage,
  type ManifestObject,
  type ResourceStatus,
} from "../webview/protocol";

/**
 * The generic resource panel, exercised on a Kind that is NOT
 * a Function. Every test here would have been impossible before the
 * generalisation: the panel only knew one Kind.
 *
 * Same seam as functions.test.ts (`ResourcePanelHost` is injectable), so
 * nothing here touches VS Code or the network; the fake records calls
 * and the assertions read them back.
 */

const PROFILE = { label: "ada", fqdn: "ada.a.airdr.es" };

function ipmSchema(): Record<string, unknown> {
  const entry = bundledSchemas().find((s) => s.kind === "InferencePoolMember");
  assert.ok(entry, "the InferencePoolMember schema must be bundled");
  return entry.schema as Record<string, unknown>;
}

function ipmManifest(name = "vllm-0"): ManifestObject {
  return {
    apiVersion: "airdress.co/v1alpha1",
    kind: "InferencePoolMember",
    metadata: { name, resourceVersion: "7" },
    spec: {
      backend: "vllm-openai",
      models: [{ name: "llama-3" }],
      url: "http://10.0.0.5:8000",
    },
  };
}

const READY: ResourceStatus = {
  phase: "Healthy",
  conditions: [{ type: "Ready", status: "True" }],
};

/** Records every call; `existing` and `conflictOnce` script the scenarios. */
class FakeHost implements ResourcePanelHost {
  readonly calls: string[] = [];
  readonly posted: HostMessage[] = [];
  readonly profile = PROFILE;
  manifest: ManifestObject = ipmManifest();
  status: ResourceStatus = READY;
  /** Names `resourceExists` answers true for. */
  existing = new Set<string>();
  /** Throw a 409 on the next applyYaml, once. */
  conflictOnce = false;
  conflictChoice: "reload" | "overwrite" | undefined = "reload";
  confirm = true;
  closed = false;
  lastApplied?: string;

  async fetchManifest(name: string): Promise<ManifestObject> {
    this.calls.push(`fetchManifest ${name}`);
    return structuredClone(this.manifest);
  }
  async fetchStatus(name: string): Promise<ResourceStatus> {
    this.calls.push(`fetchStatus ${name}`);
    return this.status;
  }
  async applyYaml(yaml: string): Promise<void> {
    this.calls.push(`applyYaml ${yaml.length}`);
    if (this.conflictOnce) {
      this.conflictOnce = false;
      const err = new Error("operator refused: resource_version is stale");
      (err as { httpStatus?: number }).httpStatus = 409;
      throw err;
    }
    this.lastApplied = yaml;
    this.manifest = YAML.parse(yaml) as ManifestObject;
  }
  async diffYaml(yaml: string): Promise<void> {
    this.calls.push(`diffYaml ${yaml.length}`);
  }
  async resourceExists(name: string): Promise<boolean> {
    this.calls.push(`resourceExists ${name}`);
    return this.existing.has(name);
  }
  async confirmConflict(name: string) {
    this.calls.push(`confirmConflict ${name}`);
    return this.conflictChoice;
  }
  async confirmDelete(name: string): Promise<boolean> {
    this.calls.push(`confirmDelete ${name}`);
    return this.confirm;
  }
  async deleteResource(name: string): Promise<void> {
    this.calls.push(`deleteResource ${name}`);
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
}

function controller(
  host: FakeHost,
  opts: { name?: string; schema?: Record<string, unknown> | null } = {},
): ResourcePanelController {
  return new ResourcePanelController(host, {
    kind: "InferencePoolMember",
    name: opts.name,
    // `null` means "explicitly no schema" (YAML mode); undefined = default.
    schema: opts.schema === null ? undefined : (opts.schema ?? ipmSchema()),
    registry: new SchemaRegistry(bundledSchemas()),
  });
}

suite("resource panel — kinds.ts capability lookup", () => {
  test("Function declares the invoke/bundle extras; nothing else does", () => {
    assert.strictEqual(capabilitiesFor("Function").extras, "function");
    assert.strictEqual(
      capabilitiesFor("InferencePoolMember").extras,
      undefined,
    );
    assert.strictEqual(capabilitiesFor("Schedule").extras, undefined);
    assert.ok(hasFunctionExtras("Function"));
    assert.ok(!hasFunctionExtras("Schedule"));
  });

  test("every Kind gets an apiVersion, including ones never seen", () => {
    assert.strictEqual(
      capabilitiesFor("Schedule").apiVersion,
      "airdress.co/v1alpha1",
    );
  });
});

suite("resource panel — form derivation is Kind-agnostic", () => {
  test("deriveSpecFields renders InferencePoolMember from its real schema", () => {
    // AC-1's precondition: the form engine never knew it was a Function.
    const fields = deriveSpecFields(ipmSchema());
    assert.ok(fields.length > 0, "a second real schema yields fields");
    const paths = fields.map((f) => f.path.join("."));
    assert.ok(paths.includes("backend"), `backend in ${paths}`);
    assert.ok(paths.includes("models"), `models in ${paths}`);
  });

  test("emptyManifest stamps kind and apiVersion, and an empty spec", () => {
    const m = emptyManifest("Schedule", "airdress.co/v1alpha1");
    assert.strictEqual(m.kind, "Schedule");
    assert.strictEqual(m.apiVersion, "airdress.co/v1alpha1");
    assert.deepStrictEqual(m.spec, {});
  });
});

suite("resource panel — YAML fallback (FR-2, AC-5)", () => {
  test("a Kind with no schema still loads, in YAML mode, with no diagnostics", async () => {
    const host = new FakeHost();
    const c = controller(host, { schema: null });
    await c.handle({ type: "load" });
    const [state] = host.states();
    assert.strictEqual(state.kind, "InferencePoolMember");
    assert.strictEqual(state.schema, undefined, "no schema rides along");
    // Validation must not claim a schema checked anything.
    const diags = c.validate(ipmManifest());
    assert.deepStrictEqual(diags, []);
  });

  test("YAML mode still refuses an unnamed manifest", () => {
    const c = controller(new FakeHost(), { schema: null });
    const diags = c.validate({ ...ipmManifest(), metadata: { name: "" } });
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].path, "/metadata/name");
  });
});

suite("resource panel — validate is Kind-generic", () => {
  test("rejects a manifest of the wrong kind by THIS panel's kind", () => {
    const c = controller(new FakeHost());
    const diags = c.validate({ ...ipmManifest(), kind: "Function" });
    assert.deepStrictEqual(diags, [
      { path: "/kind", message: 'kind must be "InferencePoolMember"' },
    ]);
  });

  test("a valid InferencePoolMember passes its own schema", () => {
    const c = controller(new FakeHost());
    assert.deepStrictEqual(c.validate(ipmManifest()), []);
  });

  test("a missing required field is reported against the schema", () => {
    const c = controller(new FakeHost());
    const m = ipmManifest();
    delete (m.spec as Record<string, unknown>).models;
    const diags = c.validate(m);
    assert.ok(diags.length > 0, "schema catches the missing `models`");
  });
});

suite("resource panel — create pre-check (FR-7, AC-1)", () => {
  test("a free name is checked, then applied — one write path", async () => {
    const host = new FakeHost();
    await controller(host).handle({
      type: "apply",
      manifest: ipmManifest("new-0"),
    });
    assert.deepStrictEqual(host.calls.slice(0, 2), [
      "resourceExists new-0",
      "applyYaml " + host.lastApplied!.length,
    ]);
    assert.ok(host.lastApplied?.includes("kind: InferencePoolMember"));
  });

  test("a taken name is refused before any write", async () => {
    const host = new FakeHost();
    host.existing.add("vllm-0");
    await controller(host).handle({
      type: "apply",
      manifest: ipmManifest("vllm-0"),
    });
    assert.deepStrictEqual(host.calls, ["resourceExists vllm-0"]);
    assert.strictEqual(host.lastApplied, undefined, "nothing was written");
    assert.ok(host.notices().some((n) => /already exists/.test(n)));
  });

  test("editing an existing resource does NOT pre-check its own name", async () => {
    const host = new FakeHost();
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    host.calls.length = 0;
    await c.handle({ type: "apply", manifest: ipmManifest("vllm-0") });
    assert.ok(!host.calls.some((x) => x.startsWith("resourceExists")));
    assert.ok(host.calls.some((x) => x.startsWith("applyYaml")));
  });
});

suite("resource panel — resourceVersion and 409 (FR-6, AC-4)", () => {
  test("load records the operator's resourceVersion and apply sends it back", async () => {
    const host = new FakeHost();
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    assert.strictEqual(host.states()[0].resourceVersion, "7");
    await c.handle({ type: "apply", manifest: ipmManifest("vllm-0") });
    const sent = YAML.parse(host.lastApplied!) as ManifestObject;
    assert.strictEqual(
      (sent.metadata as Record<string, unknown>).resourceVersion,
      "7",
      "the version rides on the apply",
    );
  });

  test("a stale apply reloads on 'reload' and writes nothing", async () => {
    const host = new FakeHost();
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    host.conflictOnce = true;
    host.conflictChoice = "reload";
    host.calls.length = 0;
    await c.handle({ type: "apply", manifest: ipmManifest("vllm-0") });
    assert.deepStrictEqual(
      host.calls.filter((x) => !x.startsWith("applyYaml")),
      ["confirmConflict vllm-0", "fetchManifest vllm-0", "fetchStatus vllm-0"],
    );
    assert.strictEqual(
      host.lastApplied,
      undefined,
      "no second write on reload",
    );
  });

  test("'overwrite' reapplies without a version — an unconditional write", async () => {
    const host = new FakeHost();
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    host.conflictOnce = true;
    host.conflictChoice = "overwrite";
    await c.handle({ type: "apply", manifest: ipmManifest("vllm-0") });
    const sent = YAML.parse(host.lastApplied!) as ManifestObject;
    assert.strictEqual(
      (sent.metadata as Record<string, unknown>).resourceVersion,
      undefined,
      "the retry drops the stale version",
    );
  });

  test("cancelling the conflict prompt writes nothing and says so", async () => {
    const host = new FakeHost();
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    host.conflictOnce = true;
    host.conflictChoice = undefined;
    await c.handle({ type: "apply", manifest: ipmManifest("vllm-0") });
    assert.strictEqual(host.lastApplied, undefined);
    assert.ok(host.notices().some((n) => /cancelled/.test(n)));
  });

  test("isConflict matches the documented 409, not message prose alone", () => {
    const e = new Error("nope");
    (e as { httpStatus?: number }).httpStatus = 409;
    assert.ok(isConflict(e));
    assert.ok(!isConflict(new Error("timeout")));
    assert.ok(isConflict(new Error("HTTP 409")));
  });

  test("readResourceVersion / stripVersion round-trip", () => {
    const m = ipmManifest();
    assert.strictEqual(readResourceVersion(m), "7");
    assert.strictEqual(readResourceVersion(stripVersion(m)), undefined);
    assert.strictEqual(readResourceVersion({ kind: "X" }), undefined);
  });
});

suite("resource panel — delete (FR-4, AC-3)", () => {
  test("a declined confirm issues no DELETE", async () => {
    const host = new FakeHost();
    host.confirm = false;
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    host.calls.length = 0;
    await c.handle({ type: "delete" });
    assert.deepStrictEqual(host.calls, ["confirmDelete vllm-0"]);
    assert.ok(!host.closed);
  });

  test("a confirmed delete issues exactly one DELETE and closes", async () => {
    const host = new FakeHost();
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    host.calls.length = 0;
    await c.handle({ type: "delete" });
    assert.deepStrictEqual(host.calls, [
      "confirmDelete vllm-0",
      "deleteResource vllm-0",
    ]);
    assert.ok(host.closed);
  });
});

suite(
  "resource panel — a Kind without Function extras cannot be invoked",
  () => {
    test("invoke on a non-Function is refused with a clear notice", async () => {
      const host = new FakeHost();
      const c = controller(host, { name: "vllm-0" });
      await c.handle({ type: "load" });
      await c.handle({ type: "invoke", body: "{}" });
      assert.ok(!host.calls.some((x) => x.startsWith("invoke")));
      assert.ok(host.notices().some((n) => /cannot be invoked/.test(n)));
    });
  },
);

suite("resource panel — apply outcome reaches the controller", () => {
  test("a declined apply confirm is news, not an error, and does not rebind or reload", async () => {
    const host = new FakeHost();
    host.applyYaml = async (yaml: string) => {
      host.calls.push(`applyYaml ${yaml.length}`);
      throw Object.assign(
        new Error("apply cancelled — the confirm was declined"),
        {
          cancelled: true,
        },
      );
    };
    const c = controller(host);
    await c.handle({ type: "apply", manifest: ipmManifest() });
    assert.strictEqual(c.name, undefined, "a cancelled create stays a draft");
    assert.ok(
      !host.calls.some((l) => l.startsWith("fetchManifest")),
      host.calls.join(),
    );
    const notice = host.posted.find((m) => m.type === "notice") as
      { level: string; message: string } | undefined;
    assert.strictEqual(notice?.level, "info");
    assert.match(notice?.message ?? "", /cancelled; nothing was written/);
  });

  test("a refused apply rejects with the operator's words — the panel shell posts them — and does not reload", async () => {
    const host = new FakeHost();
    host.applyYaml = async () => {
      throw new Error("spec.backend: echo members may not name a url");
    };
    const c = controller(host);
    await assert.rejects(
      c.handle({ type: "apply", manifest: ipmManifest() }),
      /echo members may not name a url/,
    );
    assert.strictEqual(c.name, undefined, "a refused create stays a draft");
    assert.ok(!host.calls.some((l) => l.startsWith("fetchManifest")));
  });

  test("delete names the panel's Kind, and only a Function has a route to stop", async () => {
    const host = new FakeHost();
    const c = controller(host, { name: "vllm-0" });
    await c.handle({ type: "load" });
    await c.handle({ type: "delete" });
    assert.ok(host.calls.includes("deleteResource vllm-0"));
    const done = host.notices().find((m) => /deleted from/.test(m)) ?? "";
    assert.match(done, /InferencePoolMember\/vllm-0 deleted/);
    assert.doesNotMatch(done, /\/fn\//);
  });
});
