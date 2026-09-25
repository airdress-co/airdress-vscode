import * as YAML from "yaml";
import { ApiError, type ApiClient } from "../api/client";
import { capabilitiesSuggestion, type ConfigEntry } from "./templates";
import type { TemplateRequires } from "./templateTypes";

/**
 * A Function's manifest: as the operator holds it, as `/v1/apply` takes
 * it, and as the owner keeps it beside the code (`function.yaml`).
 *
 * `function.json` is the author's request, signed and published.
 * `function.yaml` is the owner's grant and who may sign; it is never
 * published, and the tree a Deploy reads never includes it.
 */

/** The owner's manifest beside the code. */
export const OWNER_MANIFEST_FILE = "function.yaml";

export const FUNCTION_API_VERSION = "airdress.co/v1alpha1";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A Function as `GET /v1/kinds/Function/{name}` answers. */
export interface LiveFunction {
  readonly apiVersion: string;
  readonly name: string;
  readonly generation?: number;
  readonly observedGeneration?: number;
  readonly resourceVersion?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly spec: Record<string, unknown>;
  readonly status: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Decode a resource view. Both spellings of observed generation occur. */
export function decodeLiveFunction(
  name: string,
  body: unknown,
): LiveFunction | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const inner = isRecord(body.manifest) ? body.manifest : body;
  const metadata = isRecord(inner.metadata) ? inner.metadata : {};
  const spec = isRecord(inner.spec) ? inner.spec : undefined;
  if (!spec) {
    return undefined;
  }
  const labels: Record<string, string> = {};
  if (isRecord(metadata.labels)) {
    for (const [k, v] of Object.entries(metadata.labels)) {
      if (typeof v === "string") {
        labels[k] = v;
      }
    }
  }
  const rv = metadata.resourceVersion;
  return {
    apiVersion:
      typeof inner.apiVersion === "string"
        ? inner.apiVersion
        : FUNCTION_API_VERSION,
    name: typeof metadata.name === "string" ? metadata.name : name,
    generation: num(metadata.generation),
    observedGeneration:
      num(metadata.observedGeneration) ?? num(metadata.observed_generation),
    resourceVersion:
      typeof rv === "string"
        ? rv
        : typeof rv === "number"
          ? String(rv)
          : undefined,
    labels,
    spec,
    status: isRecord(body.status)
      ? body.status
      : isRecord(inner.status)
        ? inner.status
        : {},
  };
}

/** `GET /v1/kinds/Function/{name}`; undefined when there is none. */
export async function readLiveFunction(
  client: ApiClient,
  name: string,
): Promise<LiveFunction | undefined> {
  let body: unknown;
  try {
    body = await client.request<unknown>(
      `/v1/kinds/Function/${encodeURIComponent(name)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404) {
      return undefined;
    }
    throw err;
  }
  const live = decodeLiveFunction(name, body);
  if (!live) {
    throw new Error(
      `the operator's answer for Function ${name} carries no spec — it may be newer than this extension`,
    );
  }
  return live;
}

/** The document `/v1/apply` takes. */
export interface FunctionManifest {
  readonly apiVersion: string;
  readonly kind: "Function";
  readonly metadata: {
    readonly name: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly resourceVersion?: string;
  };
  readonly spec: Record<string, unknown>;
}

/**
 * The live Function with a new spec, carrying the resource version it was
 * read at: the operator refuses the apply if anything changed since.
 */
export function manifestFrom(
  live: LiveFunction,
  spec: Record<string, unknown>,
): FunctionManifest {
  return {
    apiVersion: live.apiVersion,
    kind: "Function",
    metadata: {
      name: live.name,
      ...(Object.keys(live.labels).length ? { labels: live.labels } : {}),
      ...(live.resourceVersion
        ? { resourceVersion: live.resourceVersion }
        : {}),
    },
    spec,
  };
}

/** `POST /v1/apply` with one manifest; answers the generation it wrote. */
export async function applyFunction(
  client: ApiClient,
  manifest: FunctionManifest,
): Promise<{ generation?: number }> {
  const out = await client.request<unknown>("/v1/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  });
  return { generation: isRecord(out) ? num(out.generation) : undefined };
}

/** A manifest as YAML, for a person to read or apply. */
export function manifestYaml(manifest: FunctionManifest): string {
  return YAML.stringify(manifest);
}

/**
 * The `function.yaml` a new function starts with: the runtime, the grant
 * its template asks for, and the form's configuration. It names no
 * version and no signer yet — Deploy adds both when it creates the
 * function, after showing the whole document. Nothing here is sent
 * until then.
 */
export function ownerManifestDraft(opts: {
  name: string;
  requires: TemplateRequires;
  config: readonly ConfigEntry[];
}): string {
  const head = YAML.stringify({
    apiVersion: FUNCTION_API_VERSION,
    kind: "Function",
    metadata: { name: opts.name },
    spec: { runtime: "js-source/v1" },
  }).trimEnd();
  const grant = capabilitiesSuggestion(opts.requires)
    .split("\n")
    .slice(1)
    .filter((l) => l.length > 0);
  const config =
    opts.config.length > 0
      ? YAML.stringify({ config: opts.config })
          .trimEnd()
          .split("\n")
          .map((l) => `  ${l}`)
      : [];
  return (
    [
      "# The owner's manifest for this function: what it may do (capabilities),",
      "# its configuration, and who may sign its code. It is never published.",
      "# Deploy shows it in full and applies it once, to create the function,",
      "# adding spec.source (the version and this workstation's key).",
      head,
      ...grant,
      ...config,
      "  enabled: true",
    ].join("\n") + "\n"
  );
}

/** A `function.yaml` that could not be read as a Function manifest. */
export class OwnerManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerManifestError";
  }
}

/** Parse `function.yaml`: the spec, and the name it gives. */
export function parseOwnerManifest(text: string): {
  name?: string;
  spec: Record<string, unknown>;
} {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new OwnerManifestError(
      `${OWNER_MANIFEST_FILE} is not YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(doc) || doc.kind !== "Function" || !isRecord(doc.spec)) {
    throw new OwnerManifestError(
      `${OWNER_MANIFEST_FILE} is not a Function manifest (kind: Function, with a spec).`,
    );
  }
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  return {
    name: typeof metadata.name === "string" ? metadata.name : undefined,
    spec: doc.spec,
  };
}

/**
 * Rewrite `spec.source.version` in `function.yaml` and nothing else:
 * comments, order and every other value are kept. Returns undefined when
 * the document has no `spec.source` to write into.
 */
export function withServedVersion(
  text: string,
  version: string,
): string | undefined {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0 || !doc.hasIn(["spec", "source"])) {
    return undefined;
  }
  doc.setIn(["spec", "source", "version"], version);
  return doc.toString();
}
