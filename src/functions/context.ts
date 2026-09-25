import * as YAML from "yaml";

/**
 * Which function a file belongs to, read from disk and nothing else.
 *
 * A file is inside a function when an ancestor folder (up to the
 * workspace folder) holds a `function.json` whose runtime is
 * `js-source/v1`. Three other files say more about it, each optional:
 *
 * - `function.yaml` beside it: the owner's manifest — the Function's
 *   name, the version git says runs, and who may sign;
 * - `airdress.functions.yaml` at or above it: the repository's map —
 *   which manifest this folder deploys with, and to which operator (the
 *   same file `airdress fn deploy --ci` reads);
 * - `.airdress-function.json` beside it: this editor's checkout record.
 *
 * Nothing here talks to an operator. It is pure over `FsLike`, so the
 * rules are testable without a window.
 */

/** The runtime a source function declares. */
export const SOURCE_RUNTIME = "js-source/v1";
export const FUNCTION_JSON = "function.json";
export const FUNCTION_YAML = "function.yaml";
export const MAP_FILE = "airdress.functions.yaml";
export const CHECKOUT_RECORD = ".airdress-function.json";

/** The files whose change can change what a folder resolves to. */
export const CONTEXT_FILES = [
  FUNCTION_JSON,
  FUNCTION_YAML,
  MAP_FILE,
  CHECKOUT_RECORD,
] as const;

/** Read access to a file system, by POSIX path. Undefined: not there. */
export interface FsLike {
  readText(path: string): Promise<string | undefined>;
}

/** What is known about the function a file belongs to. */
export interface FunctionContext {
  /** The function's folder (holds `function.json`). */
  readonly root: string;
  /** The Function's `metadata.name`. */
  readonly name: string;
  /** Where the name came from. */
  readonly nameFrom: "manifest" | "checkout" | "folder";
  /** `function.json`'s `entry`, relative to the root, when it names one. */
  readonly entry?: string;
  /** `function.json`'s `id`. */
  readonly functionId?: string;
  /** The owner's manifest this folder deploys with, when there is one. */
  readonly manifestPath?: string;
  /** `spec.source.version` in that manifest: what git says runs. */
  readonly committedVersion?: string;
  /** How many members `spec.source.signers` names (a single signer is 1). */
  readonly signerCount?: number;
  /** The operator's host (FQDN), from the map file or the checkout. */
  readonly operator?: string;
  readonly operatorFrom?: "map" | "checkout";
  /** The map file that names this folder, if any. */
  readonly mapPath?: string;
  /** How many (manifest, operator) pairs the map gives this folder. */
  readonly mapDeployments?: number;
  /** The checkout record, if this editor made one here. */
  readonly checkoutPath?: string;
  /** The version the folder was read from: the checkout's base, else git's. */
  readonly basedOn: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** POSIX dirname, keeping "/" for the root. */
export function dirname(p: string): string {
  const trimmed = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf("/");
  if (i < 0) {
    return ".";
  }
  return i === 0 ? "/" : trimmed.slice(0, i);
}

export function join(dir: string, name: string): string {
  if (name.startsWith("/")) {
    return name;
  }
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** `path` relative to `base` ("." for the same folder); undefined outside it. */
export function relative(base: string, path: string): string | undefined {
  const b = base.endsWith("/") && base.length > 1 ? base.slice(0, -1) : base;
  if (path === b) {
    return ".";
  }
  const prefix = b === "/" ? "/" : `${b}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/** Collapse `./`, `../` and duplicate slashes in a relative path. */
export function normalizeRelative(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length === 0 ? "." : out.join("/");
}

/** An operator as the map file or a checkout writes it, as a bare host. */
export function operatorHost(value: string): string {
  let v = value.trim();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  v = v.replace(/[/?#].*$/, "");
  return v.toLowerCase();
}

/**
 * The nearest folder at or above `from` (not above `stop`) holding
 * `name`, and that file's text.
 */
async function findUp(
  fs: FsLike,
  from: string,
  stop: string,
  name: string,
): Promise<{ dir: string; text: string } | undefined> {
  let dir = from;
  for (let i = 0; i < 64; i++) {
    const text = await fs.readText(join(dir, name));
    if (text !== undefined) {
      return { dir, text };
    }
    if (dir === stop || relative(stop, dir) === undefined) {
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/** `function.json` read as a source function's manifest, or undefined. */
export function parseSourceManifest(
  text: string,
): { entry?: string; id?: string } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(v) || v.runtime !== SOURCE_RUNTIME) {
    return undefined;
  }
  return {
    entry: typeof v.entry === "string" ? v.entry : undefined,
    id: typeof v.id === "string" ? v.id : undefined,
  };
}

/** What the owner's manifest says, read leniently: a broken file says nothing. */
export function readOwnerManifest(text: string): {
  name?: string;
  version?: string;
  signerCount?: number;
} {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(doc)) {
    return {};
  }
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  const spec = isRecord(doc.spec) ? doc.spec : {};
  const source = isRecord(spec.source) ? spec.source : {};
  let signerCount: number | undefined;
  if (Array.isArray(source.signers)) {
    signerCount = source.signers.length;
  } else if (typeof source.signer === "string" || isRecord(source.signerRef)) {
    signerCount = 1;
  } else if (isRecord(doc.spec)) {
    signerCount = 0;
  }
  return {
    name: typeof metadata.name === "string" ? metadata.name : undefined,
    version: typeof source.version === "string" ? source.version : undefined,
    signerCount,
  };
}

/** One entry of the map file that names `rel`. */
export interface MapEntry {
  readonly manifest: string;
  readonly operator?: string;
}

/**
 * The map file's entries for the function at `rel` (relative to the map
 * file's folder). Each entry's manifest defaults to `<path>/function.yaml`
 * and its operator to the file's top-level `operator`.
 */
export function mapEntriesFor(text: string, rel: string): MapEntry[] {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(doc) || !Array.isArray(doc.functions)) {
    return [];
  }
  const fallback = typeof doc.operator === "string" ? doc.operator : undefined;
  const want = normalizeRelative(rel);
  const out: MapEntry[] = [];
  for (const f of doc.functions) {
    if (!isRecord(f) || typeof f.path !== "string") {
      continue;
    }
    if (normalizeRelative(f.path) !== want) {
      continue;
    }
    const manifest =
      typeof f.manifest === "string"
        ? normalizeRelative(f.manifest)
        : normalizeRelative(`${f.path}/${FUNCTION_YAML}`);
    const operator = typeof f.operator === "string" ? f.operator : fallback;
    out.push({ manifest, operator });
  }
  return out;
}

/** The checkout record's three fields this module reads. */
function readCheckoutRecord(text: string): {
  operator?: string;
  function?: string;
  basedOn?: string | null;
} {
  try {
    const v: unknown = JSON.parse(text);
    if (!isRecord(v)) {
      return {};
    }
    return {
      operator: typeof v.operator === "string" ? v.operator : undefined,
      function: typeof v.function === "string" ? v.function : undefined,
      basedOn:
        typeof v.basedOn === "string"
          ? v.basedOn
          : v.basedOn === null
            ? null
            : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * The function `file` belongs to, or undefined. `workspaceRoot` bounds
 * the walk: nothing above it is read.
 */
export async function resolveFunctionContext(
  fs: FsLike,
  file: string,
  workspaceRoot: string,
): Promise<FunctionContext | undefined> {
  if (relative(workspaceRoot, file) === undefined) {
    return undefined;
  }
  const found = await findUp(fs, dirname(file), workspaceRoot, FUNCTION_JSON);
  if (!found) {
    return undefined;
  }
  const source = parseSourceManifest(found.text);
  if (!source) {
    return undefined;
  }
  return resolveFolder(fs, found.dir, workspaceRoot, source);
}

/** The same, for a folder already known to hold a source `function.json`. */
export async function resolveFolder(
  fs: FsLike,
  root: string,
  workspaceRoot: string,
  source: { entry?: string; id?: string },
): Promise<FunctionContext> {
  // The map file: the nearest one at or above the function's folder.
  let manifestPath = join(root, FUNCTION_YAML);
  let operator: string | undefined;
  let operatorFrom: FunctionContext["operatorFrom"];
  let mapPath: string | undefined;
  let mapDeployments: number | undefined;
  const map = await findUp(fs, root, workspaceRoot, MAP_FILE);
  if (map) {
    const rel = relative(map.dir, root) ?? ".";
    const entries = mapEntriesFor(map.text, rel);
    if (entries.length > 0) {
      mapPath = join(map.dir, MAP_FILE);
      mapDeployments = entries.length;
      manifestPath = join(map.dir, entries[0].manifest);
      if (entries[0].operator) {
        operator = operatorHost(entries[0].operator);
        operatorFrom = "map";
      }
    }
  }

  const manifestText = await fs.readText(manifestPath);
  const owner =
    manifestText !== undefined ? readOwnerManifest(manifestText) : {};

  const checkoutText = await fs.readText(join(root, CHECKOUT_RECORD));
  const record =
    checkoutText !== undefined ? readCheckoutRecord(checkoutText) : undefined;
  if (!operator && record?.operator) {
    operator = operatorHost(record.operator);
    operatorFrom = "checkout";
  }

  const folderName = root.slice(root.lastIndexOf("/") + 1);
  const name = owner.name ?? record?.function ?? folderName;
  const nameFrom: FunctionContext["nameFrom"] = owner.name
    ? "manifest"
    : record?.function
      ? "checkout"
      : "folder";
  const basedOn =
    record?.basedOn !== undefined ? record.basedOn : (owner.version ?? null);

  return {
    root,
    name,
    nameFrom,
    entry: source.entry,
    functionId: source.id,
    manifestPath: manifestText !== undefined ? manifestPath : undefined,
    committedVersion: owner.version,
    signerCount: owner.signerCount,
    operator,
    operatorFrom,
    mapPath,
    mapDeployments,
    checkoutPath:
      checkoutText !== undefined ? join(root, CHECKOUT_RECORD) : undefined,
    basedOn,
  };
}

/** The first 12 hex characters of a `sha256:` version, for a label. */
export function shortDigest(version: string | null | undefined): string {
  if (!version) {
    return "none";
  }
  const hex = version.startsWith("sha256:") ? version.slice(7) : version;
  return hex.slice(0, 12);
}

/**
 * What the operator reports for the function, reduced to what the editor
 * shows. `serving` is what runs; `loaded`/`ready` are the conditions.
 */
export interface LiveState {
  readonly kind: "live" | "absent" | "unreachable" | "no-profile";
  readonly operator?: string;
  readonly serving?: string;
  readonly loaded?: { status: string; reason?: string; message?: string };
  readonly ready?: { status: string; reason?: string; message?: string };
  /** Whether the files on disk are the files `serving` holds. */
  readonly localMatchesServing?: boolean;
  readonly error?: string;
}

/** The comparison the status bar and the lenses draw. */
export type Drift =
  | "in-step" // git's version runs
  | "git-behind" // something else runs than git says
  | "not-committed" // no function.yaml version to compare
  | "unknown";

export function driftOf(
  ctx: FunctionContext,
  live: LiveState | undefined,
): Drift {
  if (!live || live.kind !== "live" || !live.serving) {
    return "unknown";
  }
  if (!ctx.committedVersion) {
    return "not-committed";
  }
  return ctx.committedVersion === live.serving ? "in-step" : "git-behind";
}

/** The status bar's text for a function and its live state. */
export function statusText(
  ctx: FunctionContext,
  live: LiveState | undefined,
): { text: string; tooltip: string; warn: boolean } {
  const head = `$(symbol-function) ${ctx.name}`;
  if (!live) {
    return { text: head, tooltip: `Function ${ctx.name}`, warn: false };
  }
  switch (live.kind) {
    case "no-profile":
      return {
        text: head,
        tooltip: ctx.operator
          ? `Function ${ctx.name} — no signed-in profile for ${ctx.operator}.`
          : `Function ${ctx.name} — no operator named and no active profile.`,
        warn: false,
      };
    case "unreachable":
      return {
        text: `${head} $(debug-disconnect)`,
        tooltip: `Function ${ctx.name} — ${live.operator ?? "the operator"} could not be read${
          live.error ? `: ${live.error}` : ""
        }.`,
        warn: true,
      };
    case "absent":
      return {
        text: `${head} $(circle-outline) not deployed`,
        tooltip: `Function ${ctx.name} does not exist on ${live.operator}. Deploy creates it.`,
        warn: false,
      };
    case "live":
      break;
  }
  const lines = [`Function ${ctx.name} on ${live.operator}`];
  let icon = "$(pass)";
  let warn = false;
  if (live.loaded?.status === "False") {
    icon = "$(error)";
    warn = true;
    lines.push(
      `Not loaded: ${live.loaded.reason ?? "no reason"}${
        live.loaded.message ? ` — ${live.loaded.message}` : ""
      }`,
    );
    if (live.ready?.status === "True" && live.ready.reason) {
      lines.push(
        `Ready: ${live.ready.reason}${live.ready.message ? ` — ${live.ready.message}` : ""}`,
      );
    }
  }
  lines.push(`Serving ${live.serving ?? "nothing"}`);
  const drift = driftOf(ctx, live);
  if (drift === "git-behind") {
    icon = warn ? icon : "$(warning)";
    warn = true;
    lines.push(
      `${ctx.manifestPath ? "function.yaml" : "git"} says ${ctx.committedVersion} — the operator runs something else. Someone deployed since; bring it into git.`,
    );
  }
  if (live.localMatchesServing === false) {
    lines.push("This folder's files differ from what runs (not deployed yet).");
  } else if (live.localMatchesServing === true) {
    lines.push("This folder's files are what runs.");
  }
  const edited = live.localMatchesServing === false ? " $(pencil)" : "";
  return {
    text: `${head} ${icon} ${shortDigest(live.serving)}${edited}`,
    tooltip: lines.join("\n"),
    warn,
  };
}

/** One row of `GET /v1/functions/{name}/logs` as one line of text. */
export function logLineText(line: unknown): string {
  if (!isRecord(line)) {
    return String(line);
  }
  const at = typeof line.at === "string" ? line.at : "";
  const level = typeof line.level === "string" ? line.level : "";
  const kind = typeof line.kind === "string" ? line.kind : "";
  const inv =
    typeof line.invocation === "string" && line.invocation
      ? line.invocation.slice(0, 8)
      : "--------";
  const body = line.body;
  let text: string;
  if (isRecord(body) && typeof body.message === "string") {
    text = body.message;
  } else if (typeof body === "string") {
    text = body;
  } else {
    text = JSON.stringify(body);
  }
  return `${at} ${level.padEnd(5)} ${kind.padEnd(12)} ${inv} ${text}`;
}
