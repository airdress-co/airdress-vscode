import { ApiError, type ApiClient } from "../api/client";
import type {
  Template,
  TemplateField,
  TemplateRequires,
  TemplateSummary,
} from "./templateTypes";

export type { Template, TemplateField, TemplateRequires, TemplateSummary };

/**
 * The function source and template routes, as the operator serves them.
 *
 * The published contract types most of these responses as a bare
 * `object`, so the shapes are written out here from the operator's
 * handlers. Each decoder checks only what the caller relies on and
 * throws a sentence, never a TypeError, when a response does not fit.
 *
 * This module is a client of the API and nothing more: every value it
 * returns is one the operator sent, and every request it makes is one
 * a CI job could make with curl.
 */

/** One file in a stored version's index. */
export interface SourceFileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** `GET /v1/functions/sources/{version}`. */
export interface SourceVersion {
  readonly version: string;
  readonly name: string;
  readonly files: readonly SourceFileEntry[];
  readonly origin?: string;
  readonly publishedAt?: string;
  readonly publishedBy?: string;
  /** The key that signed it, hex; absent for an unsigned version. */
  readonly signer?: string;
  /** The machine it was published under, if one signed it. */
  readonly signerRef?: string;
}

/** `GET /v1/functions/{name}/versions` — only what the client reads. */
export interface SourceHistory {
  readonly name: string;
  /** The version the function serves now; null when it serves none. */
  readonly current: string | null;
}

/** The `201`/`200` body of `POST /v1/functions/sources`. */
export interface SourcePublished {
  readonly version: string;
  readonly name: string;
  readonly files: readonly SourceFileEntry[];
  readonly entry: string;
  /**
   * The canonical digest (`sha256:<hex>`) a signature is made over. Every
   * answer carries it, dry runs included; undefined only from an operator
   * older than the field.
   */
  readonly sourceDigest?: string;
  readonly unreachable: readonly string[];
  readonly warnings: readonly string[];
  readonly dryRun: boolean;
  readonly created: boolean;
}

/** Where a refusal points: an archive path, 1-based line and column. */
export interface RefusalLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/** One capability the owner has not granted. */
export interface RefusalDenial {
  readonly capability: string;
  readonly detail: string;
  readonly grantPath: string;
}

/** The structured refusal every source route answers with. */
export interface SourceRefusal {
  /** Snake-case refusal code, e.g. `transpile_failed`. */
  readonly error: string;
  /** The refusal's reason as the operator's conditions name it, e.g. `TranspileFailed`. */
  readonly reason?: string;
  readonly message: string;
  readonly locations: readonly RefusalLocation[];
  readonly denials: readonly RefusalDenial[];
}

/** `409 source_base_stale`: what the function serves instead. */
export interface StaleBase extends SourceRefusal {
  readonly error: "source_base_stale";
  readonly basedOn: string | null;
  readonly current: string;
  readonly currentPublishedAt?: string;
  readonly currentPublishedBy?: string;
}

/** One file of a publish, in the JSON file-map encoding. */
export interface PublishFile {
  readonly path: string;
  readonly contentBase64: string;
}

/** The JSON publish body. There is no field that can carry a grant. */
export interface PublishBody {
  readonly name: string;
  readonly basedOn?: string;
  readonly signature?: string;
  readonly signer?: string;
  readonly signerRef?: { readonly machine: string };
  readonly files: readonly PublishFile[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A response the client cannot read. Carries a sentence, not a stack. */
export class UnexpectedSourceResponse extends Error {
  constructor(route: string) {
    super(
      `Unrecognized response from ${route} — the operator may be newer than this extension.`,
    );
    this.name = "UnexpectedSourceResponse";
  }
}

function decodeFiles(v: unknown, route: string): SourceFileEntry[] {
  if (!Array.isArray(v)) {
    throw new UnexpectedSourceResponse(route);
  }
  return v.map((f) => {
    if (!isRecord(f) || typeof f.path !== "string") {
      throw new UnexpectedSourceResponse(route);
    }
    return {
      path: f.path,
      bytes: typeof f.bytes === "number" ? f.bytes : 0,
      sha256: typeof f.sha256 === "string" ? f.sha256 : "",
    };
  });
}

/**
 * Read a refusal body. Anything with an `error` code is one; locations
 * and denials default to empty so a caller never branches on absence.
 */
export function decodeRefusal(body: unknown): SourceRefusal | undefined {
  if (!isRecord(body) || typeof body.error !== "string") {
    return undefined;
  }
  const locations = Array.isArray(body.locations)
    ? body.locations.filter(
        (l): l is RefusalLocation => isRecord(l) && typeof l.path === "string",
      )
    : [];
  const denials = Array.isArray(body.denials)
    ? body.denials.filter(
        (d): d is RefusalDenial =>
          isRecord(d) &&
          typeof d.capability === "string" &&
          typeof d.grantPath === "string",
      )
    : [];
  return {
    ...(body as object),
    error: body.error,
    reason: typeof body.reason === "string" ? body.reason : undefined,
    message: typeof body.message === "string" ? body.message : body.error,
    locations,
    denials,
  };
}

/** Whether a refusal is the stale-base one, with the fields it promises. */
export function isStaleBase(r: SourceRefusal | undefined): r is StaleBase {
  return (
    r?.error === "source_base_stale" &&
    typeof (r as Partial<StaleBase>).current === "string"
  );
}

/** The refusal an ApiError carries, if the operator sent one. */
export function refusalOf(err: unknown): SourceRefusal | undefined {
  return err instanceof ApiError ? decodeRefusal(err.body) : undefined;
}

const enc = encodeURIComponent;

/** `GET /v1/functions/{name}/versions`. */
export async function readHistory(
  client: ApiClient,
  name: string,
): Promise<SourceHistory> {
  const route = `/v1/functions/${enc(name)}/versions`;
  const body = await client.request<unknown>(route);
  if (!isRecord(body)) {
    throw new UnexpectedSourceResponse(`GET ${route}`);
  }
  return {
    name,
    current: typeof body.current === "string" ? body.current : null,
  };
}

/** `GET /v1/functions/sources/{version}`. */
export async function readVersion(
  client: ApiClient,
  version: string,
): Promise<SourceVersion> {
  const route = `/v1/functions/sources/${enc(version)}`;
  const body = await client.request<unknown>(route);
  if (!isRecord(body) || typeof body.version !== "string") {
    throw new UnexpectedSourceResponse(`GET ${route}`);
  }
  return {
    version: body.version,
    name: typeof body.name === "string" ? body.name : "",
    files: decodeFiles(body.files, `GET ${route}`),
    origin: typeof body.origin === "string" ? body.origin : undefined,
    publishedAt:
      typeof body.publishedAt === "string" ? body.publishedAt : undefined,
    publishedBy:
      typeof body.publishedBy === "string" ? body.publishedBy : undefined,
    signer: typeof body.signer === "string" ? body.signer : undefined,
    signerRef: typeof body.signerRef === "string" ? body.signerRef : undefined,
  };
}

/**
 * The route for one file. Each path segment is encoded on its own: the
 * route takes the archive path as a wildcard, slashes included.
 */
export function fileRoute(version: string, path: string): string {
  return `/v1/functions/sources/${enc(version)}/files/${path
    .split("/")
    .map(enc)
    .join("/")}`;
}

/** `GET /v1/functions/sources/{version}/files/{path}` — the bytes, as text. */
export async function readFile(
  client: ApiClient,
  version: string,
  path: string,
): Promise<string> {
  const response = await client.send(fileRoute(version, path), {
    headers: { accept: "*/*" },
  });
  return response.text();
}

/**
 * `POST /v1/functions/sources`. `dryRun` runs every check and stores
 * nothing — the same spelling `/v1/apply` uses.
 */
export async function publishSource(
  client: ApiClient,
  body: PublishBody,
  opts: { dryRun: boolean },
): Promise<SourcePublished> {
  const route = `/v1/functions/sources${opts.dryRun ? "?dry-run=true" : ""}`;
  const out = await client.request<unknown>(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!isRecord(out) || typeof out.version !== "string") {
    throw new UnexpectedSourceResponse(`POST ${route}`);
  }
  return {
    version: out.version,
    name: typeof out.name === "string" ? out.name : body.name,
    files: decodeFiles(out.files ?? [], `POST ${route}`),
    entry: typeof out.entry === "string" ? out.entry : "",
    sourceDigest:
      typeof out.sourceDigest === "string" ? out.sourceDigest : undefined,
    unreachable: Array.isArray(out.unreachable)
      ? out.unreachable.filter((u): u is string => typeof u === "string")
      : [],
    warnings: Array.isArray(out.warnings)
      ? out.warnings.filter((w): w is string => typeof w === "string")
      : [],
    dryRun: out.dryRun === true,
    created: out.created === true,
  };
}

function decodeTemplate(v: unknown, route: string): TemplateSummary {
  if (
    !isRecord(v) ||
    typeof v.id !== "string" ||
    typeof v.title !== "string" ||
    !isRecord(v.config) ||
    !Array.isArray(v.config.fields)
  ) {
    throw new UnexpectedSourceResponse(route);
  }
  return {
    id: v.id,
    title: v.title,
    description: typeof v.description === "string" ? v.description : "",
    entry: typeof v.entry === "string" ? v.entry : "",
    requires: isRecord(v.requires) ? (v.requires as TemplateRequires) : {},
    config: { fields: v.config.fields as TemplateField[] },
  };
}

/** `GET /v1/functions/templates`. */
export async function listTemplates(
  client: ApiClient,
): Promise<TemplateSummary[]> {
  const route = "/v1/functions/templates";
  const body = await client.request<unknown>(route);
  if (!isRecord(body) || !Array.isArray(body.templates)) {
    throw new UnexpectedSourceResponse(`GET ${route}`);
  }
  return body.templates.map((t) => decodeTemplate(t, `GET ${route}`));
}

/**
 * `GET /v1/functions/templates/{id}`. With `functionId`, the operator
 * writes that id into the served `function.json` in place of the
 * template's placeholder, so the files need no editing afterwards.
 */
export async function readTemplate(
  client: ApiClient,
  id: string,
  functionId?: string,
): Promise<Template> {
  const route = `/v1/functions/templates/${enc(id)}${
    functionId ? `?functionId=${enc(functionId)}` : ""
  }`;
  const body = await client.request<unknown>(route);
  const summary = decodeTemplate(body, `GET ${route}`);
  const files = (body as Record<string, unknown>).files;
  if (
    !isRecord(files) ||
    !Object.values(files).every((c) => typeof c === "string")
  ) {
    throw new UnexpectedSourceResponse(`GET ${route}`);
  }
  return { ...summary, files: files as Record<string, string> };
}

/** The `200` body of `POST /v1/functions/{name}/promote`. */
export interface Promoted {
  readonly name: string;
  readonly version: string;
  /** What ran before; null when the function ran nothing. */
  readonly previous: string | null;
  /** The generation the write created (or the current one, unchanged). */
  readonly generation?: number;
  /** False when the version asked for was already the one running. */
  readonly changed: boolean;
}

/**
 * `POST /v1/functions/{name}/promote` — make an already published version
 * the one that runs, and change nothing else in the manifest. `basedOn`
 * is the version the caller believes runs now; the operator refuses a
 * stale one rather than overwrite a change the caller has not seen.
 */
export async function promoteVersion(
  client: ApiClient,
  name: string,
  body: { readonly version: string; readonly basedOn: string | null },
): Promise<Promoted> {
  const route = `/v1/functions/${enc(name)}/promote`;
  const out = await client.request<unknown>(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: body.version,
      ...(body.basedOn ? { basedOn: body.basedOn } : {}),
    }),
  });
  if (!isRecord(out) || typeof out.changed !== "boolean") {
    throw new UnexpectedSourceResponse(`POST ${route}`);
  }
  return {
    name: typeof out.name === "string" ? out.name : name,
    version: typeof out.version === "string" ? out.version : body.version,
    previous: typeof out.previous === "string" ? out.previous : null,
    generation: typeof out.generation === "number" ? out.generation : undefined,
    changed: out.changed,
  };
}
