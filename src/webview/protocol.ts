/**
 * Message protocol between the Function configuration panel's two
 * halves. Shared by the extension bundle and the browser bundle, so it
 * imports nothing from either side.
 *
 * Every message crossing the boundary is a discriminated union member,
 * and the extension side VALIDATES each incoming message with
 * {@link parsePanelMessage} before acting on it — a webview is a
 * separate origin whose script could be anything after a bad update,
 * so its messages are untrusted input, never trusted structure.
 */

/** A manifest as the panel holds it: a plain object, never text. */
export type ManifestObject = Record<string, unknown>;

/**
 * One condition as the operator reports it. The operator's declarative
 * framework gives every Kind the same condition shape, so this is not
 * Function-specific.
 */
export interface ResourceCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
}

/** `GET /v1/kinds/<Kind>/<name>/status`, defensively decoded. */
export interface ResourceStatus {
  phase: "Healthy" | "Failed" | "Pending" | "Unknown";
  conditions: ResourceCondition[];
  bundleSha256?: string;
  functionId?: string;
  route?: string;
  loadedAt?: string;
  lastError?: string;
}

export interface PanelDiagnostic {
  /** JSON-pointer-ish path into the manifest ("/" = root). */
  path: string;
  message: string;
}

/** Result of a test invocation against `POST /fn/<name>`. */
export interface InvocationResult {
  /** HTTP status, or undefined when the request never got an answer. */
  status?: number;
  body?: string;
  durationMs: number;
  error?: string;
}

/** Webview → extension. */
export type PanelMessage =
  | { type: "load" }
  | { type: "validate"; manifest: ManifestObject }
  | { type: "apply"; manifest: ManifestObject }
  | { type: "diff"; manifest: ManifestObject }
  | { type: "invoke"; body: string }
  | { type: "disable"; manifest: ManifestObject }
  | { type: "delete" };

/** Extension → webview. */
export type HostMessage =
  | {
      type: "state";
      /** Whether this panel edits a live resource or drafts a new one. */
      mode: "existing" | "new";
      /** The Kind being edited — drives headings and copy in the webview. */
      kind: string;
      manifest: ManifestObject;
      status?: ResourceStatus;
      /**
       * The Kind's schema, or undefined when the operator has published
       * none. Undefined selects the raw-YAML editor: the floor, not a
       * degraded mode (FR-2).
       */
      schema?: Record<string, unknown>;
      profile: { label: string; fqdn: string };
      /**
       * `metadata.resourceVersion` as the operator last reported it.
       * Sent back on apply so a stale write is refused with 409 rather
       * than silently overwriting someone else's change (FR-6).
       */
      resourceVersion?: string;
      /** A load failure, worded for a person; the form still renders. */
      loadError?: string;
    }
  | { type: "validation"; diagnostics: PanelDiagnostic[] }
  | { type: "invocation"; result: InvocationResult }
  | { type: "busy"; what: string | undefined }
  | { type: "notice"; level: "info" | "error"; message: string }
  | { type: "closed" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The manifest a webview sends is a plain object with a string `kind`
 * and a `metadata.name` string; anything else is refused here rather
 * than deeper in, where a TypeError would be the report.
 */
function isManifestObject(v: unknown): v is ManifestObject {
  return (
    isRecord(v) &&
    typeof v.kind === "string" &&
    isRecord(v.metadata) &&
    typeof v.metadata.name === "string"
  );
}

/**
 * Validate an incoming webview message. Returns `undefined` for
 * anything that is not exactly one of the protocol's shapes — an
 * unknown `type`, a missing field, a field of the wrong type, or a
 * non-object — so a caller never acts on a partial message.
 */
export function parsePanelMessage(raw: unknown): PanelMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return undefined;
  }
  switch (raw.type) {
    case "load":
    case "delete":
      return { type: raw.type };
    case "validate":
    case "apply":
    case "diff":
    case "disable":
      return isManifestObject(raw.manifest)
        ? { type: raw.type, manifest: raw.manifest }
        : undefined;
    case "invoke":
      return typeof raw.body === "string"
        ? { type: "invoke", body: raw.body }
        : undefined;
    default:
      return undefined;
  }
}

/** The route a Function is served at, from its name. */
export function functionRoute(name: string): string {
  return `/fn/${name}`;
}

/**
 * Decode a status response defensively: a phase the operator did not
 * state is "Unknown", never "Healthy"; conditions missing a type are
 * dropped rather than invented.
 */
export function parseResourceStatus(raw: unknown): ResourceStatus {
  const r = isRecord(raw) ? raw : {};
  const phaseWord = typeof r.phase === "string" ? r.phase : undefined;
  const phase: ResourceStatus["phase"] =
    phaseWord === "Healthy" || phaseWord === "Failed" || phaseWord === "Pending"
      ? phaseWord
      : "Unknown";
  const conditions: ResourceCondition[] = (
    Array.isArray(r.conditions) ? r.conditions : []
  ).flatMap((c: unknown) => {
    if (!isRecord(c) || typeof c.type !== "string") {
      return [];
    }
    const statusWord =
      c.status === true
        ? "True"
        : c.status === false
          ? "False"
          : typeof c.status === "string"
            ? c.status
            : "Unknown";
    return [
      {
        type: c.type,
        status:
          statusWord === "True" || statusWord === "False"
            ? statusWord
            : "Unknown",
        reason: typeof c.reason === "string" ? c.reason : undefined,
        message: typeof c.message === "string" ? c.message : undefined,
      },
    ];
  });
  const str = (k: string, alt?: string) =>
    typeof r[k] === "string"
      ? (r[k] as string)
      : alt && typeof r[alt] === "string"
        ? (r[alt] as string)
        : undefined;
  return {
    phase,
    conditions,
    bundleSha256: str("bundleSha256", "bundle_sha256"),
    functionId: str("functionId", "function_id"),
    route: str("route"),
    loadedAt: str("loadedAt", "loaded_at"),
    lastError: str("lastError", "last_error"),
  };
}

/**
 * An empty manifest for a "new <Kind>" panel.
 *
 * `spec` starts empty for every Kind: the form is derived from the Kind's
 * schema, which supplies defaults and required fields, so seeding anything
 * here would be this file guessing on the schema's behalf. `Function` is
 * the one exception, and only because its own schema has not published
 * yet (see `schemas/index.ts`) — the seed goes when the schema lands.
 */
export function emptyManifest(
  kind: string,
  apiVersion: string,
): ManifestObject {
  return {
    apiVersion,
    kind,
    metadata: { name: "" },
    spec:
      kind === "Function"
        ? { bundle: { path: "" }, runtime: "wasm-component/v1", enabled: true }
        : {},
  };
}
