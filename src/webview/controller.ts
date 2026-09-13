import * as YAML from "yaml";
import type { SchemaRegistry } from "../manifests/validate";
import {
  emptyManifest,
  functionRoute,
  parsePanelMessage,
  type ResourceStatus,
  type HostMessage,
  type InvocationResult,
  type ManifestObject,
  type PanelDiagnostic,
} from "./protocol";
import { capabilitiesFor } from "./kinds";

/**
 * The Function panel's state machine, with everything that touches
 * VS Code or the network behind the {@link ResourcePanelHost} seam —
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
export interface ResourcePanelHost {
  /** `GET /v1/kinds/Function/<name>` — the live manifest. */
  fetchManifest(name: string): Promise<ManifestObject>;
  /** `GET /v1/kinds/Function/<name>/status`, decoded. */
  fetchStatus(name: string): Promise<ResourceStatus>;
  /**
   * Hands YAML to the existing apply command. Resolves only when the
   * operator took the manifest; rejects with the operator's error when
   * it refused (a 409 reaches `confirmConflict`), and with
   * `{ cancelled: true }` when the user declined the confirm.
   */
  applyYaml(yaml: string): Promise<void>;
  /** Hands YAML to the existing diff command. */
  diffYaml(yaml: string): Promise<void>;
  /**
   * `POST /fn/<name>` with a raw body. Never throws for an HTTP error.
   * Present only for Kinds declaring `extras: "function"` (design §2.1)
   * — absent means the panel renders no invoke affordance.
   */
  invoke?(name: string, body: string): Promise<InvocationResult>;
  /**
   * Whether `name` already exists on the operator. Used by create to
   * refuse a silent overwrite — `/v1/apply` is an upsert, so without
   * this a new draft would replace a live resource (FR-7).
   */
  resourceExists?(name: string): Promise<boolean>;
  /**
   * Ask what to do when the operator's copy moved under us (409).
   * "reload" discards local edits, "overwrite" reapplies over theirs,
   * undefined cancels. Never resolved silently (FR-6).
   */
  confirmConflict?(name: string): Promise<"reload" | "overwrite" | undefined>;
  /** Type-to-confirm naming Kind, name and target; true = proceed. */
  confirmDelete(name: string): Promise<boolean>;
  /** `DELETE /v1/kinds/<Kind>/<name>`. */
  deleteResource(name: string): Promise<void>;
  /** Post a message into the webview. */
  post(message: HostMessage): void;
  /** Close the panel (after a delete). */
  close(): void;
  profile: { label: string; fqdn: string };
}

export interface ResourcePanelOptions {
  /** The Kind this panel edits — drives schema, routes and copy. */
  kind: string;
  /** The resource this panel edits, or undefined for a new draft. */
  name?: string;
  /**
   * The Kind's JSON Schema, or undefined when the operator has not
   * published one. Undefined selects the raw-YAML fallback, which is the
   * floor rather than a degraded mode (design §2.2).
   */
  schema?: Record<string, unknown>;
  registry: SchemaRegistry;
}

/** `metadata.resourceVersion`, when the operator reported one. */
export function readResourceVersion(
  manifest: ManifestObject,
): string | undefined {
  const metadata = manifest.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const v = (metadata as Record<string, unknown>).resourceVersion;
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
    if (typeof v === "number") {
      return String(v);
    }
  }
  return undefined;
}

/** A manifest with any resourceVersion removed — an unconditional write. */
export function stripVersion(manifest: ManifestObject): ManifestObject {
  const metadata = manifest.metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return manifest;
  }
  const copy = { ...(metadata as Record<string, unknown>) };
  delete copy.resourceVersion;
  return { ...manifest, metadata: copy };
}

/**
 * Whether an apply failure is the operator refusing a stale write.
 * Matched on the status the framework documents (409), not on message
 * text, which is not a contract.
 */
export function isConflict(err: unknown): boolean {
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus;
  if (status === 409) {
    return true;
  }
  return err instanceof Error && /\b409\b|conflict/i.test(err.message);
}

/**
 * A host's `applyYaml` rejects with `{ cancelled: true }` when the user
 * declined the apply confirm — nothing was written, and that is news,
 * not an error.
 */
export function isCancelled(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { cancelled?: unknown }).cancelled === true
  );
}

/** Name a manifest declares, or "" when unnamed. */
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

export class ResourcePanelController {
  /** The name this panel is bound to: fixed for an existing resource. */
  private boundName: string | undefined;
  /** `metadata.resourceVersion` from the last successful read. */
  private boundVersion: string | undefined;
  private busy = false;

  constructor(
    private readonly host: ResourcePanelHost,
    private readonly opts: ResourcePanelOptions,
  ) {
    this.boundName = opts.name;
  }

  /** The resource this panel currently addresses (undefined = new). */
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
    const kind = this.opts.kind;
    const name = manifestName(manifest);
    if (manifest.kind !== kind) {
      return [{ path: "/kind", message: `kind must be "${kind}"` }];
    }
    // No published schema means no schema validation. Saying a manifest
    // is valid when nothing checked it would be the panel lying; the
    // operator is the first thing that will reject a mistake instead.
    const diagnostics: PanelDiagnostic[] = this.opts.schema
      ? this.opts.registry
          .validateEnvelope({
            apiVersion: String(manifest.apiVersion ?? ""),
            kind,
            metadata: { name },
            spec: manifest.spec,
          })
          .issues.map((i) => ({ path: i.path, message: i.message }))
      : [];
    if (name.length === 0) {
      diagnostics.unshift({
        path: "/metadata/name",
        message:
          kind === "Function"
            ? "a function needs a name — it is served at /fn/<name>"
            : `a ${kind} needs a name — it is addressed by it`,
      });
    }
    return diagnostics;
  }

  /** A blank manifest for this Kind, used for new drafts and read failures. */
  private emptyDraft(): ManifestObject {
    return emptyManifest(
      this.opts.kind,
      capabilitiesFor(this.opts.kind).apiVersion,
    );
  }

  async load(): Promise<void> {
    this.host.post({ type: "busy", what: "loading" });
    const base = {
      type: "state" as const,
      kind: this.opts.kind,
      schema: this.opts.schema,
      profile: this.host.profile,
    };
    if (!this.boundName) {
      this.host.post({
        ...base,
        mode: "new",
        manifest: this.emptyDraft(),
      });
      return;
    }
    let manifest: ManifestObject;
    try {
      manifest = await this.host.fetchManifest(this.boundName);
    } catch (err) {
      // A resource that cannot be read still gets a form — one that says
      // so, drafted from the name, rather than a blank panel.
      const draft = this.emptyDraft();
      draft.metadata = { name: this.boundName };
      this.host.post({
        ...base,
        mode: "existing",
        manifest: draft,
        loadError: `Could not read ${this.opts.kind}/${this.boundName} from ${this.host.profile.fqdn} — ${describe(err)}`,
      });
      return;
    }
    let status: ResourceStatus | undefined;
    let loadError: string | undefined;
    try {
      status = await this.host.fetchStatus(this.boundName);
    } catch (err) {
      loadError = `Status for ${this.opts.kind}/${this.boundName} is unavailable — ${describe(err)}`;
    }
    this.boundVersion = readResourceVersion(manifest);
    this.host.post({
      ...base,
      mode: "existing",
      manifest,
      status,
      resourceVersion: this.boundVersion,
      loadError,
    });
  }

  private async apply(manifest: ManifestObject): Promise<void> {
    const diagnostics = this.validate(manifest);
    this.host.post({ type: "validation", diagnostics });
    if (diagnostics.length > 0) {
      this.host.post({
        type: "notice",
        level: "error",
        message: `Airdress: this ${this.opts.kind} fails schema validation — fix the marked fields first.`,
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
        message: `Airdress: this panel edits ${this.opts.kind}/${this.boundName}; a different name would create a second resource. Use "New Resource…" for that.`,
      });
      return;
    }
    // CREATE: /v1/apply is an upsert, so a draft whose name is already
    // taken would replace a live resource without saying so. Ask first.
    if (!this.boundName && this.host.resourceExists) {
      let exists: boolean;
      try {
        exists = await this.host.resourceExists(name);
      } catch {
        // Cannot tell — do not invent a verdict either way; let the
        // apply flow's own confirm carry it.
        exists = false;
      }
      if (exists) {
        this.host.post({
          type: "notice",
          level: "error",
          message: `Airdress: ${this.opts.kind}/${name} already exists on ${this.host.profile.fqdn}. Open it and edit, or choose another name.`,
        });
        return;
      }
    }

    this.host.post({ type: "busy", what: "applying" });
    try {
      await this.host.applyYaml(manifestToYaml(this.withVersion(manifest)));
    } catch (err) {
      if (isConflict(err) && this.boundName && this.host.confirmConflict) {
        const choice = await this.host.confirmConflict(this.boundName);
        if (choice === "reload") {
          await this.load();
          return;
        }
        if (choice === "overwrite") {
          // Drop the version so the upsert is unconditional — the user
          // chose this after being shown that someone else had changed it.
          this.boundVersion = undefined;
          await this.host.applyYaml(manifestToYaml(stripVersion(manifest)));
        } else {
          this.host.post({
            type: "notice",
            level: "info",
            message: "Airdress: apply cancelled; nothing was written.",
          });
          return;
        }
      } else if (isCancelled(err)) {
        this.host.post({
          type: "notice",
          level: "info",
          message: "Airdress: apply cancelled; nothing was written.",
        });
        return;
      } else {
        throw err;
      }
    }
    // `applyYaml` resolved, so the operator took it: the panel is now
    // bound to the name and shows what the operator holds after the
    // fact — including the resourceVersion the next apply must carry.
    this.boundName = name;
    await this.load();
  }

  /** The manifest with the last-read resourceVersion stamped on it. */
  private withVersion(manifest: ManifestObject): ManifestObject {
    if (!this.boundVersion) {
      return manifest;
    }
    const metadata =
      typeof manifest.metadata === "object" && manifest.metadata !== null
        ? { ...(manifest.metadata as Record<string, unknown>) }
        : {};
    metadata.resourceVersion = this.boundVersion;
    return { ...manifest, metadata };
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
        message: `Airdress: apply the ${this.opts.kind.toLowerCase()} before invoking it.`,
      });
      return;
    }
    const invoke = this.host.invoke;
    if (!invoke) {
      // A Kind without the Function extras has no invoke route at all;
      // say so rather than failing as though the call went out.
      this.host.post({
        type: "notice",
        level: "info",
        message: `Airdress: ${this.opts.kind} resources cannot be invoked.`,
      });
      return;
    }
    this.host.post({ type: "busy", what: "invoking" });
    const result = await invoke.call(this.host, this.boundName, body);
    this.host.post({ type: "invocation", result });
  }

  private async delete(): Promise<void> {
    if (!this.boundName) {
      this.host.post({
        type: "notice",
        level: "info",
        message: `Airdress: this ${this.opts.kind} has not been applied — nothing to delete.`,
      });
      return;
    }
    if (!(await this.host.confirmDelete(this.boundName))) {
      return;
    }
    this.host.post({ type: "busy", what: "deleting" });
    const kind = this.opts.kind;
    try {
      await this.host.deleteResource(this.boundName);
    } catch (err) {
      this.host.post({
        type: "notice",
        level: "error",
        message: `Airdress: deleting ${kind}/${this.boundName} from ${this.host.profile.fqdn} failed — ${describe(err)}`,
      });
      return;
    }
    // Only a Function has a route to stop answering; every other Kind
    // just has its reconciled effect torn down.
    const effect =
      capabilitiesFor(kind).extras === "function"
        ? `${functionRoute(this.boundName)} no longer answers.`
        : "its reconciled effect is being torn down.";
    this.host.post({
      type: "notice",
      level: "info",
      message: `Airdress: ${kind}/${this.boundName} deleted from ${this.host.profile.fqdn}; ${effect}`,
    });
    this.host.post({ type: "closed" });
    this.host.close();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
