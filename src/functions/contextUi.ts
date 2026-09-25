import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import * as YAML from "yaml";
import type { ApiClient } from "../api/client";
import { validateDocument } from "../manifests/apply";
import type { Profile } from "../profiles/model";
import {
  CONTEXT_FILES,
  FUNCTION_JSON,
  FUNCTION_YAML,
  MAP_FILE,
  mapEntriesFor,
  operatorHost,
  relative,
  resolveFunctionContext,
  shortDigest,
  driftOf,
  statusText,
  dirname,
  type FsLike,
  type FunctionContext,
  type LiveState,
} from "./context";
import { readLiveFunction } from "./functionManifest";
import { readTree } from "./local";
import functionSourceSchema from "./schemas/function-source.json";
import functionsLayoutSchema from "./schemas/functions-layout.json";
import { readVersion } from "./wire";

/**
 * The editor knows when a file belongs to a function (`context.ts`) and
 * shows the function's tooling there: context keys for menus, a status
 * bar item with what the operator runs, lenses in `function.json`, the
 * entry file and `function.yaml`, and schema diagnostics for the two
 * files an author edits by hand. Every operator read here is a GET.
 */

export const CONTEXT_IN_FUNCTION = "airdress.inFunction";
export const CONTEXT_HAS_MANIFEST = "airdress.functionHasManifest";
export const CONTEXT_DEPLOYABLE = "airdress.functionDeployable";

/** How long a live read is reused before the next focus asks again. */
const LIVE_TTL_MS = 20_000;

export interface ContextDeps {
  /** The signed-in profile for an operator host, if any. */
  profileFor(fqdn: string): Profile | undefined;
  /** The profile the Airdress view has active. */
  activeProfile(): Profile | undefined;
  client(profile: Profile): ApiClient;
  output: vscode.OutputChannel;
}

/** Disk reads for `context.ts`: a missing or unreadable file is undefined. */
const diskFs: FsLike = {
  async readText(path) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return undefined;
    }
  },
};

function workspaceRootOf(uri: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.path ?? "/";
}

/** The function the active editor (or a URI) belongs to, and what runs. */
export class FunctionContextService implements vscode.Disposable {
  private readonly byDir = new Map<
    string,
    Promise<FunctionContext | undefined>
  >();
  private readonly live = new Map<string, { at: number; state: LiveState }>();
  private readonly pendingLive = new Map<string, Promise<LiveState>>();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when the active function or its live state changes. */
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private active: FunctionContext | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly deps: ContextDeps) {
    const pattern = `**/{${CONTEXT_FILES.join(",")}}`;
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const forget = () => {
      this.byDir.clear();
      this.scheduleRefresh();
    };
    this.disposables.push(
      this.emitter,
      watcher,
      watcher.onDidCreate(forget),
      watcher.onDidChange(forget),
      watcher.onDidDelete(forget),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(forget),
    );
    this.scheduleRefresh();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** The function the active editor is in, as last resolved. */
  current(): FunctionContext | undefined {
    return this.active;
  }

  /** The function a file belongs to, cached per folder. */
  forUri(uri: vscode.Uri): Promise<FunctionContext | undefined> {
    if (uri.scheme !== "file") {
      return Promise.resolve(undefined);
    }
    const dir = dirname(uri.path);
    let found = this.byDir.get(dir);
    if (!found) {
      found = resolveFunctionContext(diskFs, uri.path, workspaceRootOf(uri));
      this.byDir.set(dir, found);
    }
    return found;
  }

  /** The profile a function deploys through: its operator's, else the active one. */
  profileOf(ctx: FunctionContext): Profile | undefined {
    if (ctx.operator) {
      return this.deps.profileFor(ctx.operator);
    }
    return this.deps.activeProfile();
  }

  /** Re-read the active editor's function soon (focus changes come in bursts). */
  scheduleRefresh(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.refresh(), 150);
  }

  /** Forget the live state of a function (after a deploy or a save). */
  invalidateLive(root?: string): void {
    if (root) {
      this.live.delete(root);
    } else {
      this.live.clear();
    }
    this.emitter.fire();
  }

  private async refresh(): Promise<void> {
    const gen = ++this.generation;
    const uri = vscode.window.activeTextEditor?.document.uri;
    const ctx = uri ? await this.forUri(uri) : undefined;
    if (gen !== this.generation) {
      return;
    }
    this.active = ctx;
    await vscode.commands.executeCommand(
      "setContext",
      CONTEXT_IN_FUNCTION,
      ctx !== undefined,
    );
    await vscode.commands.executeCommand(
      "setContext",
      CONTEXT_HAS_MANIFEST,
      ctx?.manifestPath !== undefined,
    );
    await vscode.commands.executeCommand(
      "setContext",
      CONTEXT_DEPLOYABLE,
      ctx !== undefined && this.profileOf(ctx) !== undefined,
    );
    this.emitter.fire();
  }

  /** The cached live state, if fresh; undefined while unknown. */
  cachedLive(ctx: FunctionContext): LiveState | undefined {
    const hit = this.live.get(ctx.root);
    return hit && Date.now() - hit.at < LIVE_TTL_MS ? hit.state : undefined;
  }

  /** What the operator runs for this function. One read at a time per folder. */
  liveFor(ctx: FunctionContext, force = false): Promise<LiveState> {
    if (!force) {
      const hit = this.cachedLive(ctx);
      if (hit) {
        return Promise.resolve(hit);
      }
    }
    const pending = this.pendingLive.get(ctx.root);
    if (pending) {
      return pending;
    }
    const read = this.readLive(ctx).then((state) => {
      this.live.set(ctx.root, { at: Date.now(), state });
      this.pendingLive.delete(ctx.root);
      this.emitter.fire();
      return state;
    });
    this.pendingLive.set(ctx.root, read);
    return read;
  }

  private async readLive(ctx: FunctionContext): Promise<LiveState> {
    const profile = this.profileOf(ctx);
    if (!profile) {
      return { kind: "no-profile", operator: ctx.operator };
    }
    const client = this.deps.client(profile);
    let live;
    try {
      live = await readLiveFunction(client, ctx.name);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.output.appendLine(
        `[context] ${ctx.name} on ${profile.fqdn}: ${error}`,
      );
      return { kind: "unreachable", operator: profile.fqdn, error };
    }
    if (!live) {
      return { kind: "absent", operator: profile.fqdn };
    }
    const status = live.status;
    const source =
      typeof live.spec.source === "object" && live.spec.source !== null
        ? (live.spec.source as Record<string, unknown>)
        : {};
    const serving =
      typeof status.sourceVersion === "string"
        ? status.sourceVersion
        : typeof source.version === "string"
          ? source.version
          : undefined;
    let localMatchesServing: boolean | undefined;
    if (serving) {
      localMatchesServing = await this.localMatches(client, ctx, serving);
    }
    return {
      kind: "live",
      operator: profile.fqdn,
      serving,
      loaded: condition(status, "Loaded"),
      ready: condition(status, "Ready"),
      localMatchesServing,
    };
  }

  /** Whether the folder's tree is, file for file, the version that runs. */
  private async localMatches(
    client: ApiClient,
    ctx: FunctionContext,
    version: string,
  ): Promise<boolean | undefined> {
    try {
      const [tree, served] = await Promise.all([
        readTree(vscode.Uri.file(ctx.root)),
        readVersion(client, version),
      ]);
      return sameFiles(
        tree,
        served.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
      );
    } catch {
      return undefined;
    }
  }
}

/** Whether a tree holds exactly these files, by path and sha256. */
export function sameFiles(
  tree: ReadonlyMap<string, Uint8Array>,
  files: ReadonlyArray<{ path: string; sha256: string }>,
): boolean {
  if (tree.size !== files.length) {
    return false;
  }
  for (const f of files) {
    const bytes = tree.get(f.path);
    if (!bytes) {
      return false;
    }
    const hex = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hex !== f.sha256.replace(/^sha256:/, "")) {
      return false;
    }
  }
  return true;
}

function condition(
  status: Record<string, unknown>,
  type: string,
): LiveState["loaded"] {
  if (!Array.isArray(status.conditions)) {
    return undefined;
  }
  for (const c of status.conditions) {
    if (
      typeof c === "object" &&
      c !== null &&
      (c as Record<string, unknown>).type === type
    ) {
      const r = c as Record<string, unknown>;
      return {
        status: String(r.status),
        reason: typeof r.reason === "string" ? r.reason : undefined,
        message: typeof r.message === "string" ? r.message : undefined,
      };
    }
  }
  return undefined;
}

/** The status bar item: the function, what runs, and whether git agrees. */
export function createFunctionStatusBar(
  service: FunctionContextService,
): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    "airdress.function",
    vscode.StatusBarAlignment.Left,
    90,
  );
  item.name = "Airdress Function";
  item.command = "airdress.functions.actions";
  const draw = () => {
    const ctx = service.current();
    if (!ctx) {
      item.hide();
      return;
    }
    const live = service.cachedLive(ctx);
    const shown = statusText(ctx, live);
    item.text = shown.text;
    item.tooltip = new vscode.MarkdownString(
      shown.tooltip
        .split("\n")
        .map((l) => l.replace(/[\\`*_[\]<>]/g, "\\$&"))
        .join("  \n") + "\n\n_Click for the function's actions._",
    );
    item.backgroundColor = shown.warn
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    item.show();
    if (!live) {
      void service.liveFor(ctx);
    }
  };
  const sub = service.onDidChange(draw);
  draw();
  return vscode.Disposable.from(item, sub);
}

/** A line/column range for a YAML/JSON path, or the first line. */
export function rangeOfPath(
  text: string,
  path: ReadonlyArray<string | number>,
  keyOnly = false,
): vscode.Range {
  const lines = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, {
    lineCounter: lines,
    keepSourceTokens: true,
  });
  let node: unknown = doc.contents;
  let keyNode: unknown;
  for (const seg of path) {
    if (YAML.isMap(node)) {
      const pair = node.items.find(
        (p) => YAML.isScalar(p.key) && String(p.key.value) === String(seg),
      );
      if (!pair) {
        break;
      }
      keyNode = pair.key;
      node = pair.value;
    } else if (YAML.isSeq(node) && typeof seg === "number") {
      keyNode = undefined;
      node = node.items[seg];
    } else {
      break;
    }
  }
  const target = (keyOnly && keyNode) || node || keyNode;
  const range =
    target && typeof target === "object" && "range" in target
      ? (target as { range?: [number, number, number] }).range
      : undefined;
  if (!range) {
    return new vscode.Range(0, 0, 0, 0);
  }
  const start = lines.linePos(range[0]);
  const end = lines.linePos(range[1]);
  return new vscode.Range(
    start.line - 1,
    start.col - 1,
    end.line - 1,
    Math.max(end.col - 1, 0),
  );
}

/** The lenses in a function's files: its actions, and what runs. */
export class FunctionLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly service: FunctionContextService) {
    service.onDidChange(() => this.emitter.fire());
  }

  async provideCodeLenses(
    doc: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const ctx = await this.service.forUri(doc.uri);
    if (!ctx) {
      return [];
    }
    const rel = relative(ctx.root, doc.uri.path);
    const top = new vscode.Range(0, 0, 0, 0);
    const actions = (range: vscode.Range) => [
      lens(range, "$(rocket) Deploy", "airdress.functions.deploy", [
        vscode.Uri.file(ctx.root),
      ]),
      lens(range, "$(check) Validate", "airdress.functions.source.validate"),
      lens(range, "$(output) Logs", "airdress.functions.logs"),
      lens(range, "$(history) Versions", "airdress.functions.versions"),
    ];
    if (
      rel === FUNCTION_JSON ||
      (ctx.entry !== undefined && rel === ctx.entry)
    ) {
      return actions(top);
    }
    if (doc.uri.path !== ctx.manifestPath) {
      return [];
    }
    const text = doc.getText();
    const out: vscode.CodeLens[] = [];
    const live = this.service.cachedLive(ctx);
    if (!live) {
      void this.service.liveFor(ctx);
    }
    const versionRange = rangeOfPath(text, ["spec", "source", "version"]);
    out.push(
      new vscode.CodeLens(versionRange, {
        title: versionLensTitle(ctx, live),
        ...(live?.kind === "no-profile"
          ? {
              command: "airdress.connectAirdress",
              tooltip: `Connect ${ctx.operator ?? "an airdress"} to read what it runs`,
            }
          : {
              command: "airdress.functions.versions",
              tooltip: "The versions this function served and stores",
            }),
      }),
    );
    const signersPath = /\bsigners\s*:/.test(text)
      ? ["spec", "source", "signers"]
      : ["spec", "source"];
    if (ctx.signerCount !== undefined) {
      out.push(
        new vscode.CodeLens(rangeOfPath(text, signersPath, true), {
          title:
            ctx.signerCount === 0
              ? "$(key) no signer named — only unsigned source is admitted"
              : `$(key) who may sign: ${ctx.signerCount} member${ctx.signerCount === 1 ? "" : "s"}`,
          command: "",
        }),
      );
    }
    return [...actions(top), ...out];
  }
}

function lens(
  range: vscode.Range,
  title: string,
  command: string,
  args: unknown[] = [],
): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command, arguments: args });
}

export function versionLensTitle(
  ctx: FunctionContext,
  live: LiveState | undefined,
): string {
  if (!live) {
    return "$(sync) reading what runs…";
  }
  switch (live.kind) {
    case "no-profile":
      return "$(circle-slash) no signed-in profile for this operator";
    case "unreachable":
      return `$(debug-disconnect) ${live.operator ?? "the operator"} could not be read`;
    case "absent":
      return `$(circle-outline) not on ${live.operator} yet — Deploy creates it`;
    case "live":
      break;
  }
  // The version can match git and still not run: say so before "serving".
  if (live.loaded?.status === "False") {
    return `$(error) not loaded on ${live.operator}: ${live.loaded.reason ?? "no reason given"}`;
  }
  switch (driftOf(ctx, live)) {
    case "in-step":
      return `$(pass) serving on ${live.operator}`;
    case "git-behind":
      return `$(warning) ${live.operator} runs ${shortDigest(live.serving)} — not this`;
    case "not-committed":
      return `$(info) ${live.operator} runs ${shortDigest(live.serving)}`;
    default:
      return `$(question) ${live.operator}: no version reported`;
  }
}

/** Schema diagnostics for `function.json` and the map file, scoped to functions. */
export class AuthoringSchemas implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(
    "airdress-function-schema",
  );
  private readonly sourceSchema: ValidateFunction;
  private readonly layoutSchema: ValidateFunction;
  private readonly disposables: vscode.Disposable[] = [this.diagnostics];

  constructor(private readonly service: FunctionContextService) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    this.sourceSchema = ajv.compile(functionSourceSchema);
    this.layoutSchema = ajv.compile(functionsLayoutSchema);
    const check = (doc: vscode.TextDocument, typing = false) =>
      void this.check(doc, typing);
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(check),
      vscode.workspace.onDidChangeTextDocument((e) => check(e.document, true)),
      vscode.workspace.onDidCloseTextDocument((d) =>
        this.diagnostics.delete(d.uri),
      ),
    );
    for (const doc of vscode.workspace.textDocuments) {
      check(doc);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * A save. Called from the extension's one save hook (there is exactly
   * one, and a test holds it to that), never from a listener of its own.
   */
  saved(doc: vscode.TextDocument): Promise<void> {
    return this.check(doc);
  }

  /**
   * `typing` is a keystroke: `function.json` and the map file are checked
   * on each one (Ajv, local, cheap); the owner's manifest only on open and
   * save, because its check reports "valid" in the status bar.
   */
  private async check(doc: vscode.TextDocument, typing = false): Promise<void> {
    if (doc.uri.scheme !== "file") {
      return;
    }
    const base = doc.uri.path.slice(doc.uri.path.lastIndexOf("/") + 1);
    if (base === MAP_FILE) {
      this.diagnostics.set(
        doc.uri,
        schemaDiagnostics(this.layoutSchema, doc.getText(), "yaml"),
      );
      return;
    }
    if (base !== FUNCTION_JSON && base !== FUNCTION_YAML) {
      return;
    }
    const ctx = await this.service.forUri(doc.uri);
    if (!ctx) {
      return;
    }
    if (base === FUNCTION_JSON) {
      this.diagnostics.set(
        doc.uri,
        schemaDiagnostics(this.sourceSchema, doc.getText(), "json"),
      );
    } else if (!typing && doc.uri.path === ctx.manifestPath) {
      // The owner's manifest is a Function manifest: the bundled Kind schema.
      validateDocument(doc);
    }
  }
}

/** Ajv errors as diagnostics placed on the key or value they name. */
export function schemaDiagnostics(
  validate: ValidateFunction,
  text: string,
  format: "json" | "yaml",
): vscode.Diagnostic[] {
  let value: unknown;
  try {
    value = format === "json" ? JSON.parse(text) : YAML.parse(text);
  } catch (err) {
    return [
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        `Not ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
        vscode.DiagnosticSeverity.Error,
      ),
    ];
  }
  if (validate(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: vscode.Diagnostic[] = [];
  for (const e of validate.errors ?? []) {
    // `anyOf`/`oneOf` report every arm; the summary line says enough.
    if (e.keyword === "anyOf" || e.keyword === "oneOf") {
      continue;
    }
    const { path, message, keyOnly } = describeError(e);
    const key = `${path.join("/")}|${message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const d = new vscode.Diagnostic(
      rangeOfPath(text, path, keyOnly),
      message,
      vscode.DiagnosticSeverity.Error,
    );
    d.source = "airdress";
    out.push(d);
  }
  return out;
}

function describeError(e: ErrorObject): {
  path: Array<string | number>;
  message: string;
  keyOnly: boolean;
} {
  const path: Array<string | number> = e.instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  const at = path.length ? path.join(".") : "the document";
  if (e.keyword === "additionalProperties") {
    const extra = String(
      (e.params as { additionalProperty?: string }).additionalProperty,
    );
    return {
      path: [...path, extra],
      message: `${extra} is not a field of ${at === "the document" ? "this file" : at}.`,
      keyOnly: true,
    };
  }
  if (e.keyword === "required") {
    const missing = String(
      (e.params as { missingProperty?: string }).missingProperty,
    );
    return { path, message: `${at} needs ${missing}.`, keyOnly: true };
  }
  if (e.keyword === "pattern" && path[path.length - 1] === "id") {
    return {
      path,
      message:
        "The function id is reverse-DNS: lowercase labels joined by dots, at least two (e.g. local.my-function or co.example.hello).",
      keyOnly: false,
    };
  }
  return {
    path,
    message: `${at} ${e.message ?? "is invalid"}.`,
    keyOnly: false,
  };
}

/**
 * After a signer-set apply, write the live set into every committed
 * manifest for this function in the workspace — `function.yaml` beside a
 * function, or a manifest the map file names — so git says who may sign.
 * Only `spec.source.signers` changes (a single `signer`/`signerRef` is
 * replaced by the set); comments and every other value are kept.
 */
export async function syncCommittedSigners(
  profile: Profile,
  name: string,
  signers: unknown[],
  output: vscode.OutputChannel,
): Promise<string[]> {
  const candidates = new Map<string, string | undefined>();
  for (const uri of await vscode.workspace.findFiles(
    `**/${FUNCTION_YAML}`,
    "**/node_modules/**",
    200,
  )) {
    candidates.set(uri.path, undefined);
  }
  for (const uri of await vscode.workspace.findFiles(
    `**/${MAP_FILE}`,
    "**/node_modules/**",
    20,
  )) {
    let text: string | undefined;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
        "utf8",
      );
    } catch {
      continue;
    }
    const dir = dirname(uri.path);
    let doc: unknown;
    try {
      doc = YAML.parse(text);
    } catch {
      continue;
    }
    const fns =
      typeof doc === "object" &&
      doc !== null &&
      Array.isArray((doc as Record<string, unknown>).functions)
        ? ((doc as Record<string, unknown>).functions as unknown[])
        : [];
    for (const f of fns) {
      if (typeof f !== "object" || f === null) {
        continue;
      }
      const path = (f as Record<string, unknown>).path;
      if (typeof path !== "string") {
        continue;
      }
      for (const entry of mapEntriesFor(text, path)) {
        candidates.set(`${dir}/${entry.manifest}`, entry.operator);
      }
    }
  }
  const written: string[] = [];
  for (const [path, operator] of candidates) {
    if (operator && operatorHost(operator) !== profile.fqdn.toLowerCase()) {
      continue;
    }
    const uri = vscode.Uri.file(path);
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
        "utf8",
      );
    } catch {
      continue;
    }
    const next = withSignerSet(text, name, signers);
    if (next !== undefined && next !== text) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(next, "utf8"));
      written.push(path);
      output.appendLine(`[signers] updated ${path}`);
    }
  }
  return written;
}

/**
 * `text` with `spec.source.signers` set to `signers`, when it is the
 * Function manifest for `name` with a `spec.source`; else undefined.
 */
export function withSignerSet(
  text: string,
  name: string,
  signers: unknown[],
): string | undefined {
  const doc = YAML.parseDocument(text);
  if (
    doc.errors.length > 0 ||
    doc.get("kind") !== "Function" ||
    doc.getIn(["metadata", "name"]) !== name ||
    !doc.hasIn(["spec", "source"])
  ) {
    return undefined;
  }
  doc.deleteIn(["spec", "source", "signer"]);
  doc.deleteIn(["spec", "source", "signerRef"]);
  doc.setIn(["spec", "source", "signers"], doc.createNode(signers));
  return doc.toString();
}
