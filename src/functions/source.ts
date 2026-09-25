import * as vscode from "vscode";
import { ApiError, type ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import {
  publishSourceConfirm,
  rebaseSourceConfirm,
  targetPhrase,
} from "../profiles/confirm";
import { applyDiagnostics, refusalDiagnostics } from "./diagnostics";
import {
  archivePathOf,
  checkoutFor,
  MANIFEST_FILE,
  publishBody,
  readCheckout,
  canonicalDigestString,
  readTree,
  sha256Hex,
  writeCheckout,
  type Checkout,
  type SigningChoice,
  type SourceTree,
} from "./local";
import {
  isStaleBase,
  publishSource,
  readFile,
  readHistory,
  readVersion,
  refusalOf,
  type SourceFileEntry,
  type SourcePublished,
  type SourceRefusal,
  type StaleBase,
} from "./wire";

/**
 * The editing loop for a function's source.
 *
 *   list → open → check out → edit → save (dry run) → publish
 *
 * Every step is one of the operator's own routes. Validation is the
 * operator's `?dry-run=true`, not a local imitation of it; the refusal's
 * own locations become markers. A publish names the version the tree was
 * read from (`basedOn`), and a stale base is shown as a difference for a
 * person to read — this module never retries a refused publish.
 *
 * Publishing stores a version; it does not change what runs. That is
 * still `apply`, with the manifest naming `spec.source.version`.
 */

/** Read-only documents for a served version's files. */
export const SOURCE_SCHEME = "airdress-source";

/** Everything the loop needs from the editor, injectable for tests. */
export interface SourceUI {
  info(message: string, ...actions: string[]): Thenable<string | undefined>;
  warn(message: string, ...actions: string[]): Thenable<string | undefined>;
  error(message: string): void;
  /** A modal confirm; true only when `action` was chosen. */
  confirm(message: string, action: string): Thenable<boolean>;
  pick(items: string[], placeHolder: string): Thenable<string | undefined>;
  ask(prompt: string, value?: string): Thenable<string | undefined>;
  pickFolder(defaultUri?: vscode.Uri): Thenable<vscode.Uri | undefined>;
  diff(left: vscode.Uri, right: vscode.Uri, title: string): Thenable<void>;
  open(uri: vscode.Uri): Thenable<void>;
  status(message: string): void;
}

export interface SourceDeps {
  client(profile: Profile): ApiClient;
  /** The profile a checkout's operator names, if one is configured. */
  profileFor(fqdn: string): Profile | undefined;
  /** Which operator a folder with no record should publish to. */
  pickProfile(): Promise<Profile | undefined>;
  diagnostics: vscode.DiagnosticCollection;
  signing(): Promise<SigningChoice>;
  ui: SourceUI;
}

/** The first twelve hex characters of a version — enough to tell apart. */
export function shortVersion(version: string | null | undefined): string {
  if (!version) {
    return "nothing";
  }
  const hex = version.startsWith("sha256:") ? version.slice(7) : version;
  return hex.slice(0, 12);
}

/**
 * `airdress-source://<profile>/<version>/<archive path>`: one file of one
 * stored version. The version `-` is the empty side of a difference, for
 * a file that exists on one side only.
 */
export function servedUri(
  profileId: string,
  version: string,
  archivePath: string,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: SOURCE_SCHEME,
    authority: profileId,
    path: `/${encodeURIComponent(version)}/${archivePath}`,
  });
}

/** The (profile id, version, path) a served URI names. */
export function parseServedUri(
  uri: vscode.Uri,
): { profileId: string; version: string; path: string } | undefined {
  const m = /^\/([^/]+)\/(.+)$/.exec(uri.path);
  if (uri.scheme !== SOURCE_SCHEME || !m) {
    return undefined;
  }
  return {
    profileId: uri.authority,
    version: decodeURIComponent(m[1]),
    path: m[2],
  };
}

/**
 * Serves stored files, fetched when opened. No file system provider is
 * registered for the scheme, so the documents cannot be saved: an edit
 * happens in a checkout, never here.
 */
export class ServedSourceProvider
  implements vscode.TextDocumentContentProvider
{
  constructor(
    private readonly clientFor: (profileId: string) => ApiClient | undefined,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parsed = parseServedUri(uri);
    if (!parsed || parsed.version === "-") {
      return "";
    }
    const client = this.clientFor(parsed.profileId);
    if (!client) {
      return "// The profile this file was opened through no longer exists.\n";
    }
    return readFile(client, parsed.version, parsed.path);
  }
}

/** What the tree shows under a Function. */
export type SourceListing =
  | {
      readonly kind: "files";
      readonly version: string;
      readonly files: readonly SourceFileEntry[];
      /**
       * Set when the manifest imports its source: the files are readable,
       * and the authoring API will not write them.
       */
      readonly importedFrom?: string;
    }
  | { readonly kind: "none"; readonly reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `spec` of a live Function, wherever the operator put it. */
function specOf(live: unknown): Record<string, unknown> {
  if (isRecord(live) && isRecord(live.spec)) {
    return live.spec;
  }
  if (
    isRecord(live) &&
    isRecord(live.manifest) &&
    isRecord(live.manifest.spec)
  ) {
    return live.manifest.spec;
  }
  return {};
}

/** Where the applied manifest imports its source from, if it does. */
export function importPathOf(live: unknown): string | undefined {
  const source = specOf(live).source;
  if (isRecord(source) && isRecord(source.import)) {
    return typeof source.import.path === "string"
      ? source.import.path
      : "an import";
  }
  return undefined;
}

/**
 * A Function's files: the applied manifest (to learn whether it imports),
 * the history (to learn which version it serves), then that version's
 * index. Three reads, all of them routes a CI job could call.
 */
export async function sourceListing(
  client: ApiClient,
  name: string,
): Promise<SourceListing> {
  const live = await client.request<unknown>(
    `/v1/kinds/Function/${encodeURIComponent(name)}`,
  );
  const spec = specOf(live);
  if (spec.bundle !== undefined && spec.source === undefined) {
    return {
      kind: "none",
      reason: "Served from a WebAssembly bundle — there is no source to list.",
    };
  }
  const importedFrom = importPathOf(live);
  let history;
  try {
    history = await readHistory(client, name);
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404) {
      return {
        kind: "none",
        reason: "This operator does not serve function source.",
      };
    }
    throw err;
  }
  if (!history.current) {
    return {
      kind: "none",
      reason: importedFrom
        ? `Imported from ${importedFrom}; no version has been admitted yet.`
        : "No source version has been applied yet.",
    };
  }
  const version = await readVersion(client, history.current);
  return {
    kind: "files",
    version: version.version,
    files: version.files,
    importedFrom,
  };
}

/** What configuration management owns, said as a fact and not an error. */
export function managedExternallyMessage(
  name: string,
  importedFrom: string,
): string {
  return (
    `${name} is served from an import (${importedFrom}), so configuration ` +
    "management owns its source and the operator will not accept a publish " +
    "for it. Its files are readable here. To author it in the editor " +
    "instead, apply its manifest with spec.source.version naming the version " +
    "it serves, then edit from that."
  );
}

/** The entry file a tree names, if `function.json` parses. */
function entryOf(manifestText: string): string | undefined {
  try {
    const m: unknown = JSON.parse(manifestText);
    return isRecord(m) && typeof m.entry === "string" ? m.entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy the served version into a folder, with a record of which function
 * and which version it came from, and open its entry file.
 */
export async function checkOut(
  deps: SourceDeps,
  profile: Profile,
  name: string,
  defaultFolder?: vscode.Uri,
): Promise<Checkout | undefined> {
  const client = deps.client(profile);
  const listing = await sourceListing(client, name);
  if (listing.kind === "none") {
    await deps.ui.info(`Airdress: ${name} — ${listing.reason}`);
    return undefined;
  }
  if (listing.importedFrom) {
    await deps.ui.info(
      `Airdress: ${managedExternallyMessage(name, listing.importedFrom)}`,
    );
    return undefined;
  }
  const root = await deps.ui.pickFolder(defaultFolder);
  if (!root) {
    return undefined;
  }
  const existing = await readCheckout(root);
  if (existing) {
    if (
      existing.record.function !== name ||
      existing.record.operator !== profile.fqdn
    ) {
      deps.ui.error(
        `Airdress: ${root.fsPath} already holds ${existing.record.function} ` +
          `from ${existing.record.operator}. Pick an empty folder.`,
      );
      return undefined;
    }
    // Same function: never overwrite an edit in progress.
    await deps.ui.info(
      `Airdress: ${root.fsPath} already holds ${name}, based on ` +
        `${shortVersion(existing.record.basedOn)} — opening it as it is.`,
    );
    await openEntry(deps, existing);
    return existing;
  }
  for (const f of listing.files) {
    const text = await readFile(client, listing.version, f.path);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, ...f.path.split("/")),
      Buffer.from(text, "utf8"),
    );
  }
  const checkout: Checkout = {
    root,
    record: {
      operator: profile.fqdn,
      function: name,
      basedOn: listing.version,
    },
  };
  await writeCheckout(root, checkout.record);
  await openEntry(deps, checkout);
  return checkout;
}

async function openEntry(deps: SourceDeps, checkout: Checkout): Promise<void> {
  let entry: string | undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(checkout.root, MANIFEST_FILE),
    );
    entry = entryOf(Buffer.from(bytes).toString("utf8"));
  } catch {
    entry = undefined;
  }
  await deps.ui.open(
    vscode.Uri.joinPath(checkout.root, ...(entry ?? MANIFEST_FILE).split("/")),
  );
}

/** The operator's digest of a tree is not the one this editor computed. */
export class DigestMismatchError extends Error {
  constructor(
    readonly local: string,
    readonly served: string | undefined,
  ) {
    super(
      served === undefined
        ? "the operator did not say which digest a signature must cover (no sourceDigest in its answer), so the editor will not sign"
        : `the operator digests this tree as ${served}, the editor as ${local}. ` +
            "A signature over the editor's digest would not verify; nothing was signed.",
    );
    this.name = "DigestMismatchError";
  }
}

/**
 * Send a tree. Every send starts with an unsigned dry run, which the
 * operator checks without verifying and which needs no key. A dry run
 * stops there. A publish then holds the operator's `sourceDigest` to the
 * locally computed one — they must be the same bytes the signature covers
 * — and only then reads the signing key, signs, and sends for real.
 */
export async function publishTree(
  client: ApiClient,
  name: string,
  basedOn: string | null,
  tree: SourceTree,
  signing: () => Promise<SigningChoice>,
  opts: { dryRun: boolean },
): Promise<SourcePublished> {
  const checked = await publishSource(
    client,
    publishBody(name, basedOn, tree, {}),
    { dryRun: true },
  );
  if (opts.dryRun) {
    return checked;
  }
  const local = canonicalDigestString(tree);
  if (checked.sourceDigest !== local) {
    throw new DigestMismatchError(local, checked.sourceDigest);
  }
  return publishSource(
    client,
    publishBody(name, basedOn, tree, await signing()),
    { dryRun: false },
  );
}

/** Why a signing refusal happened, in terms of this editor's settings. */
function signingHint(code: string): string {
  return code === "source_unsigned" ||
    code === "source_signature_invalid" ||
    code === "source_signer_mismatch"
    ? " The editor signs with the seed named in airdress.functions.signingKeyFile" +
        " (and names airdress.functions.signerMachine when set)."
    : "";
}

/** Outcome of one publish or dry run, for callers and tests. */
export type PublishOutcome =
  | { readonly kind: "ok"; readonly published: SourcePublished }
  | { readonly kind: "stale"; readonly stale: StaleBase }
  | { readonly kind: "managed"; readonly message: string }
  | { readonly kind: "refused"; readonly refusal: SourceRefusal }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" };

/**
 * Send a checkout's tree to the operator. `dryRun` stores nothing; a
 * real publish asks first, naming where it goes. Markers are replaced
 * with whatever the operator answered — cleared when it accepts.
 */
export async function publishCheckout(
  deps: SourceDeps,
  checkout: Checkout,
  opts: { dryRun: boolean },
): Promise<PublishOutcome> {
  const { record } = checkout;
  const profile = deps.profileFor(record.operator);
  if (!profile) {
    const message = `Airdress: no profile for ${record.operator}, which ${record.function} was read from. Add one first.`;
    deps.ui.error(message);
    return { kind: "failed", message };
  }
  let tree: SourceTree;
  try {
    tree = await readTree(checkout.root);
  } catch (err) {
    const message = `Airdress: ${err instanceof Error ? err.message : String(err)}`;
    deps.ui.error(message);
    return { kind: "failed", message };
  }
  if (
    !opts.dryRun &&
    !(await deps.ui.confirm(
      publishSourceConfirm(record.function, profile),
      "Publish",
    ))
  ) {
    return { kind: "cancelled" };
  }
  let published: SourcePublished;
  try {
    published = await publishTree(
      deps.client(profile),
      record.function,
      record.basedOn,
      tree,
      deps.signing,
      opts,
    );
  } catch (err) {
    if (err instanceof DigestMismatchError) {
      deps.ui.error(`Airdress: nothing was published — ${err.message}`);
      return { kind: "failed", message: err.message };
    }
    const refusal = refusalOf(err);
    if (isStaleBase(refusal)) {
      applyDiagnostics(deps.diagnostics, checkout.root, []);
      await offerStale(deps, profile, checkout, refusal);
      return { kind: "stale", stale: refusal };
    }
    if (refusal?.error === "source_managed_externally") {
      // Not a failure of the edit: the function has another owner.
      applyDiagnostics(deps.diagnostics, checkout.root, []);
      await deps.ui.info(`Airdress: ${refusal.message}`);
      return { kind: "managed", message: refusal.message };
    }
    if (refusal) {
      const placed = refusalDiagnostics(checkout.root, refusal);
      applyDiagnostics(deps.diagnostics, checkout.root, placed);
      if (placed.length === 0) {
        deps.ui.error(
          `Airdress: ${record.function} refused (${refusal.error}): ${refusal.message}.${signingHint(refusal.error)}`,
        );
      } else {
        deps.ui.status(
          `Airdress: ${record.function} refused — ${refusal.error}, see Problems`,
        );
      }
      return { kind: "refused", refusal };
    }
    const message = `Airdress: ${opts.dryRun ? "checking" : "publishing"} ${record.function} on ${profile.fqdn} failed — ${
      err instanceof Error ? err.message : String(err)
    }`;
    deps.ui.error(message);
    return { kind: "failed", message };
  }
  applyDiagnostics(deps.diagnostics, checkout.root, []);
  const unreachable =
    published.unreachable.length > 0
      ? ` Not reached from the entry: ${published.unreachable.join(", ")}.`
      : "";
  if (opts.dryRun) {
    deps.ui.status(
      `Airdress: ${record.function} passes the operator's checks.${unreachable}`,
    );
    return { kind: "ok", published };
  }
  await writeCheckout(checkout.root, {
    ...record,
    published: [...(record.published ?? []), published.version].slice(-20),
  });
  await deps.ui.info(
    `Airdress: ${published.created ? "stored" : "already held"} ${record.function} ` +
      `as ${published.version} on ${targetPhrase(profile)}. Nothing runs it ` +
      "until the Function manifest names it — spec.source.version — and is applied." +
      unreachable +
      (published.warnings.length ? ` ${published.warnings.join(" ")}` : ""),
  );
  return { kind: "ok", published };
}

/** The stale-base actions. There is deliberately no "publish anyway". */
export const SHOW_DIFFERENCE = "Show the Difference";

/**
 * A stale base: say what moved, and offer to show it. When the version
 * the function serves now is one this folder published itself, also
 * offer to take it as the base — the difference is then this person's
 * own edit. Neither choice publishes.
 */
export async function offerStale(
  deps: SourceDeps,
  profile: Profile,
  checkout: Checkout,
  stale: StaleBase,
): Promise<void> {
  const { record } = checkout;
  const ours = record.published?.includes(stale.current) ?? false;
  const rebase = `Base on ${shortVersion(stale.current)}`;
  const by = stale.currentPublishedBy
    ? ` (published by ${stale.currentPublishedBy}${stale.currentPublishedAt ? ` at ${stale.currentPublishedAt}` : ""})`
    : "";
  const message = ours
    ? `Airdress: ${record.function} now serves ${shortVersion(stale.current)}, which this folder published; ` +
      `this edit is still based on ${shortVersion(record.basedOn)}. Nothing was stored.`
    : `Airdress: ${record.function} has moved since this folder was read — it serves ` +
      `${shortVersion(stale.current)}${by}, and this edit is based on ` +
      `${shortVersion(record.basedOn)}. Nothing was stored.`;
  const actions = ours ? [SHOW_DIFFERENCE, rebase] : [SHOW_DIFFERENCE];
  const choice = await deps.ui.warn(message, ...actions);
  if (choice === SHOW_DIFFERENCE) {
    await showDifference(deps, profile, checkout, stale.current);
  } else if (choice === rebase && ours) {
    await writeCheckout(checkout.root, { ...record, basedOn: stale.current });
    deps.ui.status(
      `Airdress: ${record.function} is now based on ${shortVersion(stale.current)}. Publish when ready.`,
    );
  }
}

/**
 * Open a diff of the served version against the local edit, one file at
 * a time: the files whose bytes differ, picked from when there are
 * several. A file on one side only diffs against an empty document.
 */
export async function showDifference(
  deps: SourceDeps,
  profile: Profile,
  checkout: Checkout,
  version: string,
): Promise<void> {
  const served = await readVersion(deps.client(profile), version);
  const local = await readTree(checkout.root);
  const servedSha = new Map(served.files.map((f) => [f.path, f.sha256]));
  const paths = [...new Set([...servedSha.keys(), ...local.keys()])].sort();
  const changed = paths.filter((p) => {
    const bytes = local.get(p);
    return !bytes || servedSha.get(p) !== sha256Hex(bytes);
  });
  if (changed.length === 0) {
    await deps.ui.info(
      `Airdress: this folder's tree is byte-identical to ${shortVersion(version)}.`,
    );
    return;
  }
  const path =
    changed.length === 1
      ? changed[0]
      : await deps.ui.pick(
          changed,
          "Files that differ from the served version",
        );
  if (!path) {
    return;
  }
  const left = servedSha.has(path)
    ? servedUri(profile.id, version, path)
    : servedUri(profile.id, "-", path);
  const right = local.has(path)
    ? vscode.Uri.joinPath(checkout.root, ...path.split("/"))
    : servedUri(profile.id, "-", path);
  await deps.ui.diff(
    left,
    right,
    `${path} — served ${shortVersion(version)} ⟷ your edit (based on ${shortVersion(checkout.record.basedOn)})`,
  );
}

/**
 * The save hook: a dry run of the checkout the saved file belongs to.
 * Files outside a checkout, or outside its tree, are ignored. This path
 * is fixed to `dryRun: true` — a save never stores a version, and never
 * applies anything.
 */
export async function validateOnSave(
  deps: SourceDeps,
  file: vscode.Uri,
): Promise<PublishOutcome | undefined> {
  if (file.scheme !== "file") {
    return undefined;
  }
  const checkout = await checkoutFor(file);
  if (!checkout || archivePathOf(checkout.root, file) === undefined) {
    return undefined;
  }
  return publishCheckout(deps, checkout, { dryRun: true });
}

/**
 * A folder with a tree and no record — a fork, or source written by hand
 * — is bound to a function by asking which one. It starts with no base:
 * if that function already serves a version the operator says so, and
 * the difference is offered like any other stale base.
 */
export async function adoptFolder(
  deps: SourceDeps,
  root: vscode.Uri,
): Promise<Checkout | undefined> {
  const existing = await readCheckout(root);
  if (existing) {
    return existing;
  }
  const profile = await deps.pickProfile();
  if (!profile) {
    return undefined;
  }
  const name = (
    await deps.ui.ask(
      `Which Function on ${targetPhrase(profile)} is this tree for? (its metadata.name)`,
    )
  )?.trim();
  if (!name) {
    return undefined;
  }
  const checkout: Checkout = {
    root,
    record: { operator: profile.fqdn, function: name, basedOn: null },
  };
  await writeCheckout(root, checkout.record);
  return checkout;
}

/**
 * Take the version a function serves now as this folder's base — asked
 * for by a person, after the difference, never done on their behalf.
 */
export async function rebaseCheckout(
  deps: SourceDeps,
  checkout: Checkout,
): Promise<void> {
  const { record } = checkout;
  const profile = deps.profileFor(record.operator);
  if (!profile) {
    deps.ui.error(`Airdress: no profile for ${record.operator}.`);
    return;
  }
  const { current } = await readHistory(deps.client(profile), record.function);
  if (!current || current === record.basedOn) {
    await deps.ui.info(
      `Airdress: ${record.function} is already based on what it serves (${shortVersion(current)}).`,
    );
    return;
  }
  if (
    !(await deps.ui.confirm(
      rebaseSourceConfirm(record.function, current, profile),
      "Take as Base",
    ))
  ) {
    return;
  }
  await writeCheckout(checkout.root, { ...record, basedOn: current });
  deps.ui.status(
    `Airdress: ${record.function} is now based on ${shortVersion(current)}.`,
  );
}
