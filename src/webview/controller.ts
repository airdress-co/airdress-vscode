import * as YAML from "yaml";
import type { SchemaRegistry } from "../manifests/validate";
import {
  emptyFunctionManifest,
  functionRoute,
  parsePanelMessage,
  type FunctionStatus,
  type HostMessage,
  type InvocationResult,
  type ManifestObject,
  type PanelDiagnostic,
} from "./protocol";

/**
 * The Function panel's state machine, with everything that touches
 * VS Code or the network behind the {@link FunctionPanelHost} seam —
 * the same shape principals/admin.ts uses — so the transitions are
 * unit-tested with a fake host and no editor.
 *
 * Rules the machine holds:
 * - Apply and diff hand the manifest to the EXISTING flows
 *   (`applyManifest`, `diffAgainstLive`) through the host; this file
 *   never posts to /v1/apply itself, so there is exactly one apply
 *   path in the extension and it still confirms profile + FQDN.
 * - An invalid manifest never reaches apply: validation runs first and
 *   the diagnostics go back to the form.
 * - Delete asks the host to confirm, with the name and the FQDN, and
 *   only then issues the request.
 * - Nothing here fires on any event other than a message the webview's
 *   user sent.
 */

/** What the panel needs from its surroundings. Injectable for tests. */
export interface FunctionPanelHost {
  /** `GET /v1/kinds/Function/<name>` — the live manifest. */
  fetchManifest(name: string): Promise<ManifestObject>;
  /** `GET /v1/kinds/Function/<name>/status`, decoded. */
  fetchStatus(name: string): Promise<FunctionStatus>;
  /** Hands YAML to the existing apply command; resolves when it returns. */
  applyYaml(yaml: string): Promise<void>;
  /** Hands YAML to the existing diff command. */
  diffYaml(yaml: string): Promise<void>;
  /** `POST /fn/<name>` with a raw body. Never throws for an HTTP error. */
  invoke(name: string, body: string): Promise<InvocationResult>;
  /** Modal confirm naming the function and the target; true = proceed. */
  confirmDelete(name: string): Promise<boolean>;
  /** `DELETE /v1/kinds/Function/<name>`. */
  deleteFunction(name: string): Promise<void>;
  /** Post a message into the webview. */
  post(message: HostMessage): void;
  /** Close the panel (after a delete). */
  close(): void;
  profile: { label: string; fqdn: string };
}

export interface FunctionPanelOptions {
  /** The function this panel edits, or undefined for a new draft. */
  name?: string;
  schema: Record<string, unknown>;
  registry: SchemaRegistry;
}

/** Name of the function a manifest declares, or "" when unnamed. */
export function manifestName(manifest: ManifestObject): string {
  const metadata = manifest.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const name = (metadata as Record<string, unknown>).name;
    return typeof name === "string" ? name : "";
  }
  return "";
}

/** The YAML text the apply/diff flows receive. */
export function manifestToYaml(manifest: ManifestObject): string {
  return YAML.stringify(manifest);
}

/** Copy a manifest with `spec.enabled` set to false. */
export function disabledCopy(manifest: ManifestObject): ManifestObject {
  const spec =
    typeof manifest.spec === "object" && manifest.spec !== null
      ? { ...(manifest.spec as Record<string, unknown>) }
      : {};
  return { ...manifest, spec: { ...spec, enabled: false } };
}

export class FunctionPanelController {
  /** The name this panel is bound to: fixed for an existing resource. */
  private boundName: string | undefined;
  private busy = false;

  constructor(
    private readonly host: FunctionPanelHost,
    private readonly opts: FunctionPanelOptions,
  ) {
    this.boundName = opts.name;
  }

  /** The function this panel currently addresses (undefined = new). */
  get name(): string | undefined {
    return this.boundName;
  }

  /**
   * Entry point for every webview message. Malformed messages are
   * dropped (with an error notice) — never partially handled.
   */
  async handle(raw: unknown): Promise<void> {
    const message = parsePanelMessage(raw);
    if (!message) {
      this.host.post({
        type: "notice",
        level: "error",
        message: "The panel sent a message the extension does not understand.",
      });
      return;
    }
    if (this.busy && message.type !== "load") {
      this.host.post({
        type: "notice",
        level: "info",
        message: "Airdress: still working on the previous action.",
      });
      return;
    }
    this.busy = true;
    try {
      switch (message.type) {
        case "load":
          await this.load();
          return;
        case "validate":
          this.host.post({
            type: "validation",
            diagnostics: this.validate(message.manifest),
          });
          return;
        case "apply":
          await this.apply(message.manifest);
          return;
        case "disable":
          await this.apply(disabledCopy(message.manifest));
          return;
        case "diff":
          await this.diff(message.manifest);
          return;
        case "invoke":
          await this.invoke(message.body);
          return;
        case "delete":
          await this.delete();
          return;
      }
    } finally {
      this.busy = false;
      this.host.post({ type: "busy", what: undefined });
    }
  }

  validate(manifest: ManifestObject): PanelDiagnostic[] {
    const name = manifestName(manifest);
    if (manifest.kind !== "Function") {
      return [{ path: "/kind", message: 'kind must be "Function"' }];
    }
    const result = this.opts.registry.validateEnvelope({
      apiVersion: String(manifest.apiVersion ?? ""),
      kind: "Function",
      metadata: { name },
      spec: manifest.spec,
    });
    const diagnostics = result.issues.map((i) => ({
      path: i.path,
      message: i.message,
    }));
    if (name.length === 0) {
      diagnostics.unshift({
        path: "/metadata/name",
        message: "a function needs a name — it is served at /fn/<name>",
      });
    }
    return diagnostics;
  }

  async load(): Promise<void> {
    this.host.post({ type: "busy", what: "loading" });
    const base = {
      type: "state" as const,
      schema: this.opts.schema,
      profile: this.host.profile,
    };
    if (!this.boundName) {
      this.host.post({
        ...base,
        mode: "new",
        manifest: emptyFunctionManifest(),
      });
      return;
    }
    let manifest: ManifestObject;
    try {
      manifest = await this.host.fetchManifest(this.boundName);
    } catch (err) {
      // A resource that cannot be read still gets a form — one that says
      // so, drafted from the name, rather than a blank panel.
      const draft = emptyFunctionManifest();
      draft.metadata = { name: this.boundName };
      this.host.post({
        ...base,
        mode: "existing",
        manifest: draft,
        loadError: `Could not read Function/${this.boundName} from ${this.host.profile.fqdn} — ${describe(err)}`,
      });
      return;
    }
    let status: FunctionStatus | undefined;
    let loadError: string | undefined;
    try {
      status = await this.host.fetchStatus(this.boundName);
    } catch (err) {
      loadError = `Status for Function/${this.boundName} is unavailable — ${describe(err)}`;
    }
    this.host.post({ ...base, mode: "existing", manifest, status, loadError });
  }

  private async apply(manifest: ManifestObject): Promise<void> {
    const diagnostics = this.validate(manifest);
    this.host.post({ type: "validation", diagnostics });
    if (diagnostics.length > 0) {
      this.host.post({
        type: "notice",
        level: "error",
        message:
          "Airdress: the function fails schema validation — fix the marked fields first.",
      });
      return;
    }
    const name = manifestName(manifest);
    if (this.boundName && name !== this.boundName) {
      // Renaming through the panel would apply a SECOND function and
      // leave the first in place — say so instead of doing it.
      this.host.post({
        type: "notice",
        level: "error",
        message: `Airdress: this panel edits Function/${this.boundName}; a different name would create a new function. Use "New Function" for that.`,
      });
      return;
    }
    this.host.post({ type: "busy", what: "applying" });
    await this.host.applyYaml(manifestToYaml(manifest));
    // The apply flow confirms and reports by itself; whatever it did,
    // the panel is now bound to the name and shows what the operator
    // holds after the fact.
    this.boundName = name;
    await this.load();
  }

  private async diff(manifest: ManifestObject): Promise<void> {
    this.host.post({ type: "busy", what: "diffing" });
    await this.host.diffYaml(manifestToYaml(manifest));
  }

  private async invoke(body: string): Promise<void> {
    if (!this.boundName) {
      this.host.post({
        type: "notice",
        level: "error",
        message: "Airdress: apply the function before invoking it.",
      });
      return;
    }
    this.host.post({ type: "busy", what: "invoking" });
    const result = await this.host.invoke(this.boundName, body);
    this.host.post({ type: "invocation", result });
  }

  private async delete(): Promise<void> {
    if (!this.boundName) {
      this.host.post({
        type: "notice",
        level: "info",
        message:
          "Airdress: this function has not been applied — nothing to delete.",
      });
      return;
    }
    if (!(await this.host.confirmDelete(this.boundName))) {
      return;
    }
    this.host.post({ type: "busy", what: "deleting" });
    try {
      await this.host.deleteFunction(this.boundName);
    } catch (err) {
      this.host.post({
        type: "notice",
        level: "error",
        message: `Airdress: deleting Function/${this.boundName} from ${this.host.profile.fqdn} failed — ${describe(err)}`,
      });
      return;
    }
    this.host.post({
      type: "notice",
      level: "info",
      message: `Airdress: Function/${this.boundName} deleted from ${this.host.profile.fqdn}; ${functionRoute(this.boundName)} no longer answers.`,
    });
    this.host.post({ type: "closed" });
    this.host.close();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
