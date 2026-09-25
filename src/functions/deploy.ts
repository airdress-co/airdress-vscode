import * as vscode from "vscode";
import * as YAML from "yaml";
import { ApiError, type ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import {
  deployCreateConfirm,
  deployReplaceConfirm,
  targetPhrase,
} from "../profiles/confirm";
import { applyDiagnostics, refusalDiagnostics } from "./diagnostics";
import {
  applyFunction,
  manifestFrom,
  manifestYaml,
  OWNER_MANIFEST_FILE,
  OwnerManifestError,
  ownerManifestDraft,
  parseOwnerManifest,
  readLiveFunction,
  withServedVersion,
  FUNCTION_API_VERSION,
  type FunctionManifest,
  type LiveFunction,
} from "./functionManifest";
import {
  canonicalDigestString,
  LocalTreeError,
  publishBody,
  readTree,
  writeCheckout,
  type Checkout,
  type SigningChoice,
  type SourceTree,
} from "./local";
import {
  allowedSigners,
  describeMember,
  describeSet,
  describeVersionSigner,
  isKeyMember,
  isMember,
  listMachines,
  sameMember,
  thisClientMember,
  versionSigner,
  type MachineInfo,
  type SignerMember,
} from "./signers";
import {
  managedExternallyMessage,
  offerStale,
  shortVersion,
  type SourceDeps,
} from "./source";
import { DeployStop, type DeployStep, type DeployStopCode } from "./stops";
import {
  isStaleBase,
  promoteVersion,
  publishSource,
  readVersion,
  refusalOf,
  type SourceRefusal,
  type StaleBase,
} from "./wire";

/**
 * Deploy: one command from an edited folder to a function serving it.
 *
 *   0 resolve   the function, and whether this editor may sign for it
 *   1 check     an unsigned dry-run publish of the folder, read once
 *   2 digest    the operator's digest of it must equal this editor's
 *   3 confirm   one prompt, before the first write
 *   4 sign      over that digest
 *   5 publish   the same bytes, signed
 *   6 promote   (an existing function) or apply (a new one)
 *   7 wait      until the function reports the new version loaded
 *
 * The command line runs the same steps in the same order and stops for
 * the same reasons (`stops.ts`). There is no deploy route on the
 * operator: every step is a call a script could make.
 *
 * Deploy never applies to an existing function — promote changes only
 * which version runs, so a stale local copy of the grant, the config or
 * the signer set cannot overwrite the live one. Widening a grant and
 * changing who may sign are offered as their own acts, never folded in.
 */

export interface DeployDeps extends SourceDeps {
  /** Make a key for this workstation and return the signing choice. */
  createKey(): Promise<SigningChoice>;
  /** Whether this profile acts as the airdress's owner. */
  isOwner(profile: Profile): boolean;
  /** A modal with a headline, detail and buttons; the button chosen. */
  choose(
    message: string,
    detail: string,
    ...actions: string[]
  ): Thenable<string | undefined>;
  /** Open text as an untitled YAML document. */
  openDraft(yaml: string): Thenable<void>;
  /** "Allow this workstation…": the signer-set flow, its own apply. */
  allowSigner?(
    profile: Profile,
    name: string,
    member: SignerMember,
  ): Promise<void>;
  clock?: Clock;
  /** How long step 7 waits for a verdict. */
  waitTimeoutMs?: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The measured cold engine compile is ~15 s; this leaves margin. */
export const DEFAULT_WAIT_MS = 60_000;

/** What one Deploy did. */
export type DeployOutcome =
  | {
      readonly kind: "deployed";
      readonly created: boolean;
      readonly version: string;
      readonly previous: string | null;
      readonly elapsedMs: number;
    }
  | { readonly kind: "unchanged"; readonly version: string }
  | {
      readonly kind: "stopped";
      readonly code: DeployStopCode;
      readonly message: string;
      readonly refusal?: SourceRefusal;
    }
  | {
      readonly kind: "refused";
      readonly step: DeployStep;
      readonly refusal: SourceRefusal;
    }
  | {
      readonly kind: "stale";
      readonly step: DeployStep;
      readonly stale: StaleBase;
    }
  | { readonly kind: "managed"; readonly message: string }
  | {
      readonly kind: "failed";
      readonly step: DeployStep;
      readonly message: string;
    };

export const CREATE_KEY = "Create a Signing Key";
export const DEPLOY = "Deploy";
export const CREATE_AND_DEPLOY = "Create and Deploy";
export const EDIT_GRANT_FIRST = "Edit Grant First…";
export const WIDEN_GRANT = "Widen the Grant…";
export const ALLOW_THIS_WORKSTATION = "Allow This Workstation…";
export const DRAFT_MANIFEST = "Draft the Manifest";

/** Refusal codes a promote's 404 carries; any other 404 is a missing route. */
const PROMOTE_NOT_FOUND = new Set([
  "function_not_found",
  "source_version_not_found",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a Deploy for a folder bound to a function. */
export async function deployCheckout(
  deps: DeployDeps,
  checkout: Checkout,
): Promise<DeployOutcome> {
  const { record } = checkout;
  const profile = deps.profileFor(record.operator);
  if (!profile) {
    const message = `Airdress: no profile for ${record.operator}, which ${record.function} deploys to. Add one first.`;
    deps.ui.error(message);
    return { kind: "failed", step: "resolve", message };
  }
  const run = new DeployRun(deps, profile, checkout);
  try {
    return await run.run();
  } catch (err) {
    if (err instanceof DeployStop) {
      return run.stopped(err);
    }
    const message = `Airdress: deploying ${record.function} failed at ${run.step} — ${messageOf(err)}`;
    deps.ui.error(message);
    return { kind: "failed", step: run.step, message };
  }
}

/** One Deploy's state, so each step reads as the table above. */
class DeployRun {
  step: DeployStep = "resolve";
  private readonly client: ApiClient;
  private readonly name: string;
  private live: LiveFunction | undefined;
  private signing: SigningChoice = {};
  private machines: MachineInfo[] = [];

  constructor(
    private readonly deps: DeployDeps,
    private readonly profile: Profile,
    private readonly checkout: Checkout,
  ) {
    this.client = deps.client(profile);
    this.name = checkout.record.function;
  }

  async run(): Promise<DeployOutcome> {
    const { deps, name } = this;
    // 0 — resolve the function, its signer set, and this editor's signer.
    this.live = await readLiveFunction(this.client, name);
    const creating = this.live === undefined;
    const source = this.live?.spec.source;
    if (this.live && !isRecord(source)) {
      const message = `Airdress: ${name} runs a WebAssembly bundle; Deploy sends source. Change a bundle function with Configure Function.`;
      deps.ui.error(message);
      return { kind: "failed", step: "resolve", message };
    }
    if (isRecord(source) && isRecord(source.import)) {
      const from =
        typeof source.import.path === "string"
          ? source.import.path
          : "an import";
      const message = managedExternallyMessage(name, from);
      await deps.ui.info(`Airdress: ${message}`);
      return { kind: "managed", message };
    }
    const set = creating ? [] : allowedSigners(source);
    this.signing = await deps.signing();
    if (!this.signing.key && (creating || set.length > 0)) {
      this.signing = await this.offerKey();
    }
    if (set.some((m) => !isKeyMember(m)) || this.signing.machine) {
      this.machines = await listMachines(this.client);
    }
    let signAs: SigningChoice = this.signing;
    if (!creating && set.length === 0) {
      // The function names no signer: only unsigned source is admitted,
      // and only where the operator allows it. A signature would be
      // refused as coming from nobody the manifest names.
      signAs = {};
      deps.ui.status(
        `Airdress: ${name} names no signer, so this Deploy is unsigned — the operator accepts that only when it allows unsigned source.`,
      );
    } else if (!creating && !isMember(set, this.signing, this.machines)) {
      await this.notThisClient(set);
    }

    // 1 — the snapshot, read once, and the unsigned check.
    this.step = "check";
    let tree: SourceTree;
    try {
      tree = await readTree(this.checkout.root);
    } catch (err) {
      if (err instanceof LocalTreeError) {
        throw new DeployStop("layout_invalid", `Airdress: ${err.message}`);
      }
      throw err;
    }
    const basedOn = creating ? null : this.checkout.record.basedOn;
    let checked;
    try {
      checked = await publishSource(
        this.client,
        publishBody(name, basedOn, tree, {}),
        { dryRun: true },
      );
    } catch (err) {
      return this.refused(err);
    }
    applyDiagnostics(deps.diagnostics, this.checkout.root, []);

    // 2 — the operator digests exactly the bytes this editor will sign.
    this.step = "digest";
    const local = canonicalDigestString(tree);
    if (checked.sourceDigest !== local) {
      throw new DeployStop(
        "digest_mismatch",
        checked.sourceDigest === undefined
          ? `Airdress: the operator did not say which digest a signature must cover (no sourceDigest), so nothing was signed.`
          : `Airdress: the operator digests this folder as ${checked.sourceDigest}, the editor as ${local}. Nothing was signed; this is a defect to report.`,
      );
    }

    // 3 — one confirmation, before the first write.
    this.step = "confirm";
    const createManifest = creating
      ? await this.createManifestDraft(tree)
      : undefined;
    // The version the operator will store (it includes the engine), not
    // the tree's own digest: this is the name the status bar will show.
    const offered = checked.version || local;
    const confirmed = createManifest
      ? await this.confirmCreate(createManifest, offered, tree.size)
      : await this.confirmReplace(
          offered,
          tree.size,
          checked.unreachable.length,
          signAs,
        );
    if (!confirmed) {
      return {
        kind: "stopped",
        code: "confirmation_declined",
        message: "Nothing was deployed.",
      };
    }

    // 4, 5 — sign over the digest, and publish the same snapshot.
    this.step = "publish";
    let published;
    try {
      published = await publishSource(
        this.client,
        publishBody(name, basedOn, tree, signAs),
        { dryRun: false },
      );
    } catch (err) {
      return this.refused(err);
    }
    if (
      published.sourceDigest !== undefined &&
      published.sourceDigest !== local
    ) {
      throw new DeployStop(
        "digest_mismatch",
        `Airdress: the operator stored ${published.version} under digest ${published.sourceDigest}, not ${local}. It was not deployed.`,
      );
    }
    const version = published.version;
    await writeCheckout(this.checkout.root, {
      ...this.checkout.record,
      published: [...(this.checkout.record.published ?? []), version].slice(
        -20,
      ),
    });

    // 6 — make it run: promote (exists) or one owner apply (new).
    let generation: number | undefined;
    let previous: string | null = null;
    if (createManifest) {
      this.step = "apply";
      const manifest = withVersion(createManifest, version);
      try {
        generation = (await applyFunction(this.client, manifest)).generation;
      } catch (err) {
        return this.refused(err);
      }
      await this.recordCreated(manifest);
    } else {
      this.step = "promote";
      try {
        const promoted = await promoteVersion(this.client, name, {
          version,
          basedOn,
        });
        previous = promoted.previous;
        generation = promoted.generation;
        if (!promoted.changed) {
          return this.unchanged(version);
        }
      } catch (err) {
        const refusal = refusalOf(err);
        // A retry after a promote that did land: the base moved to
        // exactly the version asked for. Already done, not a stop.
        if (isStaleBase(refusal) && refusal.current === version) {
          return this.unchanged(version);
        }
        if (
          err instanceof ApiError &&
          (err.httpStatus === 405 ||
            (err.httpStatus === 404 &&
              !PROMOTE_NOT_FOUND.has(refusal?.error ?? "")))
        ) {
          return this.predatesPromote(version);
        }
        return this.refused(err);
      }
    }

    // 7 — wait for the verdict.
    this.step = "wait";
    const elapsedMs = await waitForLoaded(
      this.client,
      name,
      version,
      generation,
      (m) => deps.ui.status(`Airdress: ${name} — ${m}`),
      deps.clock ?? realClock,
      deps.waitTimeoutMs ?? DEFAULT_WAIT_MS,
    );
    await this.served(version);
    await deps.ui.info(
      `Airdress: ${name} ${creating ? "created and " : ""}serving ${shortVersion(version)} on ${this.profile.fqdn} — loaded in ${(elapsedMs / 1000).toFixed(1)} s.`,
    );
    return {
      kind: "deployed",
      created: creating,
      version,
      previous,
      elapsedMs,
    };
  }

  /** No key: offer to make one. Declining stops with `signer_unavailable`. */
  private async offerKey(): Promise<SigningChoice> {
    const choice = await this.deps.choose(
      "This workstation has no key to sign function code with.",
      "Airdress can make one now. It is kept in this computer's keychain and " +
        "never leaves it; only its public half is written into the function, " +
        "as the signer allowed to deploy it.",
      CREATE_KEY,
    );
    if (choice !== CREATE_KEY) {
      throw new DeployStop(
        "signer_unavailable",
        "Nothing was deployed: there is no key to sign with. Create one when you Deploy, or name a key file in airdress.functions.signingKeyFile.",
      );
    }
    return this.deps.createKey();
  }

  /** This editor is not in the set: say who is, and who can change it. */
  private async notThisClient(set: readonly SignerMember[]): Promise<never> {
    const me = thisClientMember(this.signing);
    const who = describeSet(set, this.machines);
    const message =
      `Airdress: ${this.name} may be deployed by ${who} — not by this workstation` +
      `${me ? ` (${describeMember(me, this.machines)})` : ""}. ` +
      "Adding a signer is an apply by the owner.";
    const owner = this.deps.isOwner(this.profile);
    const offer =
      owner && me && this.deps.allowSigner ? [ALLOW_THIS_WORKSTATION] : [];
    const choice = await this.deps.ui.warn(message, ...offer);
    if (choice === ALLOW_THIS_WORKSTATION && me && this.deps.allowSigner) {
      await this.deps.allowSigner(this.profile, this.name, me);
    }
    throw new DeployStop("signer_not_this_client", message);
  }

  /** `function.yaml` as the create will apply it, drafting one if absent. */
  private async createManifestDraft(
    tree: SourceTree,
  ): Promise<FunctionManifest> {
    const text = await this.readOwnerManifest();
    // With no function.yaml, grant exactly what function.json asks for,
    // for the owner to read in the confirmation — as the CLI does. An empty
    // grant creates a function that then fails to load.
    let spec: Record<string, unknown> = {
      runtime: "js-source/v1",
      capabilities: requestedCapabilities(tree),
      enabled: true,
    };
    if (text !== undefined) {
      let parsed;
      try {
        parsed = parseOwnerManifest(text);
      } catch (err) {
        if (err instanceof OwnerManifestError) {
          throw new DeployStop("layout_invalid", `Airdress: ${err.message}`);
        }
        throw err;
      }
      if (parsed.name && parsed.name !== this.name) {
        throw new DeployStop(
          "layout_invalid",
          `Airdress: ${OWNER_MANIFEST_FILE} names ${parsed.name}, but this folder deploys ${this.name}.`,
        );
      }
      spec = { ...parsed.spec, runtime: "js-source/v1" };
    }
    const me = thisClientMember(this.signing);
    if (!me) {
      throw new DeployStop(
        "signer_unavailable",
        "Nothing was deployed: a new function needs a signer, and there is no key to sign with.",
      );
    }
    const existing = isRecord(spec.source) ? spec.source : {};
    const set = allowedSigners(existing);
    const signers = set.some((m) => sameMember(m, me)) ? set : [me, ...set];
    const rest = Object.fromEntries(
      Object.entries(existing).filter(
        ([k]) => !["signer", "signerRef", "signers", "version"].includes(k),
      ),
    );
    return {
      apiVersion: FUNCTION_API_VERSION,
      kind: "Function",
      metadata: { name: this.name },
      spec: {
        ...spec,
        source: {
          ...rest,
          version: "",
          signers: signers.map((m) =>
            isKeyMember(m)
              ? { key: m.key.toLowerCase() }
              : { machine: m.machine },
          ),
        },
      },
    };
  }

  private async confirmCreate(
    manifest: FunctionManifest,
    version: string,
    files: number,
  ): Promise<boolean> {
    const spec = manifest.spec;
    const config = Array.isArray(spec.config) ? spec.config : [];
    const secretValues = config.filter(
      (c) => isRecord(c) && c.valueFrom !== undefined,
    ).length;
    const grantYaml =
      spec.capabilities !== undefined &&
      !(
        isRecord(spec.capabilities) &&
        Object.keys(spec.capabilities).length === 0
      )
        ? YAML.stringify({ spec: { capabilities: spec.capabilities } })
        : "";
    const text = deployCreateConfirm(
      {
        name: this.name,
        template: this.checkout.record.template,
        version,
        files,
        signers: describeSet(
          allowedSigners(spec.source),
          this.machines,
          this.signing,
        ),
        grantYaml,
        configValues: config.length,
        secretValues,
      },
      this.profile,
    );
    const choice = await this.deps.choose(
      text.message,
      text.detail,
      CREATE_AND_DEPLOY,
      EDIT_GRANT_FIRST,
    );
    if (choice === EDIT_GRANT_FIRST) {
      await this.openOwnerManifest();
    }
    return choice === CREATE_AND_DEPLOY;
  }

  private async confirmReplace(
    version: string,
    files: number,
    unreached: number,
    signAs: SigningChoice,
  ): Promise<boolean> {
    const live = this.live!;
    const replacing =
      isRecord(live.spec.source) && typeof live.spec.source.version === "string"
        ? live.spec.source.version
        : null;
    let note: string | undefined;
    if (replacing) {
      try {
        const info = await readVersion(this.client, replacing);
        const signer = versionSigner(live.status, info);
        note = [
          info.publishedAt ? `published ${info.publishedAt}` : undefined,
          signer
            ? `signed by ${describeVersionSigner(signer, this.machines)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(", ");
      } catch {
        note = undefined;
      }
    }
    const me = thisClientMember(signAs);
    const text = deployReplaceConfirm(
      {
        name: this.name,
        replacing: replacing ?? "nothing",
        replacingNote: note || undefined,
        version,
        files,
        unreached,
        signer: me
          ? `${describeMember(me, this.machines, signAs)} — a member of this function's signers`
          : "nobody (unsigned)",
      },
      this.profile,
    );
    return (
      (await this.deps.choose(text.message, text.detail, DEPLOY)) === DEPLOY
    );
  }

  private ownerManifestUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.checkout.root, OWNER_MANIFEST_FILE);
  }

  private async readOwnerManifest(): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.ownerManifestUri());
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return undefined;
    }
  }

  private async writeOwnerManifest(text: string): Promise<void> {
    await vscode.workspace.fs.writeFile(
      this.ownerManifestUri(),
      Buffer.from(text, "utf8"),
    );
  }

  /**
   * After a create, `function.yaml` holds the manifest that was applied:
   * its `spec.source` is written into the owner's file (comments and the
   * rest kept), or the whole manifest when there was none.
   */
  private async recordCreated(manifest: FunctionManifest): Promise<void> {
    const text = await this.readOwnerManifest();
    if (text !== undefined) {
      const doc = YAML.parseDocument(text);
      if (doc.errors.length === 0 && doc.hasIn(["spec"])) {
        doc.setIn(["spec", "source"], doc.createNode(manifest.spec.source));
        await this.writeOwnerManifest(doc.toString());
        return;
      }
    }
    await this.writeOwnerManifest(manifestYaml(manifest));
  }

  /** "Edit grant first…": open `function.yaml`, drafting it if absent. */
  private async openOwnerManifest(): Promise<void> {
    if ((await this.readOwnerManifest()) === undefined) {
      await this.writeOwnerManifest(
        ownerManifestDraft({ name: this.name, requires: {}, config: [] }),
      );
    }
    await this.deps.ui.open(this.ownerManifestUri());
  }

  /** After a verdict: the folder's base, and `function.yaml`'s version. */
  private async served(version: string): Promise<void> {
    await writeCheckout(this.checkout.root, {
      ...this.checkout.record,
      basedOn: version,
      published: [...(this.checkout.record.published ?? []), version]
        .filter((v, i, all) => all.indexOf(v) === i)
        .slice(-20),
    });
    const text = await this.readOwnerManifest();
    if (text === undefined) {
      return;
    }
    const rewritten = withServedVersion(text, version);
    if (rewritten === undefined) {
      this.deps.ui.status(
        `Airdress: ${OWNER_MANIFEST_FILE} has no spec.source; its version was not updated.`,
      );
    } else if (rewritten !== text) {
      await this.writeOwnerManifest(rewritten);
    }
  }

  private async unchanged(version: string): Promise<DeployOutcome> {
    await this.served(version);
    await this.deps.ui.info(
      `Airdress: ${this.name} already serves ${shortVersion(version)} on ${this.profile.fqdn}; nothing changed.`,
    );
    return { kind: "unchanged", version };
  }

  /** The operator has no promote: offer today's flow, publish then apply. */
  private async predatesPromote(version: string): Promise<DeployOutcome> {
    const message =
      `Airdress: ${targetPhrase(this.profile)} cannot promote (it predates that route). ` +
      `${shortVersion(version)} is published; to run it, apply the Function manifest naming it.`;
    const choice = await this.deps.ui.warn(message, DRAFT_MANIFEST);
    if (choice === DRAFT_MANIFEST && this.live) {
      const source = isRecord(this.live.spec.source)
        ? this.live.spec.source
        : {};
      await this.deps.openDraft(
        manifestYaml(
          manifestFrom(this.live, {
            ...this.live.spec,
            source: { ...source, version },
          }),
        ),
      );
    }
    return {
      kind: "stopped",
      code: "operator_predates_promote",
      message,
    };
  }

  /** An operator refusal: verbatim, under the step that received it. */
  async refused(err: unknown): Promise<DeployOutcome> {
    const refusal = refusalOf(err);
    const { deps, name } = this;
    if (!refusal) {
      throw err;
    }
    if (isStaleBase(refusal)) {
      applyDiagnostics(deps.diagnostics, this.checkout.root, []);
      await offerStale(deps, this.profile, this.checkout, refusal);
      return { kind: "stale", step: this.step, stale: refusal };
    }
    if (refusal.error === "source_managed_externally") {
      applyDiagnostics(deps.diagnostics, this.checkout.root, []);
      await deps.ui.info(`Airdress: ${refusal.message}`);
      return { kind: "managed", message: refusal.message };
    }
    const placed = refusalDiagnostics(this.checkout.root, refusal);
    applyDiagnostics(deps.diagnostics, this.checkout.root, placed);
    const owner = deps.isOwner(this.profile);
    const actions: string[] = [];
    if (
      refusal.error === "capability_not_granted" &&
      owner &&
      this.live !== undefined
    ) {
      actions.push(WIDEN_GRANT);
    }
    const me = thisClientMember(this.signing);
    if (
      refusal.error === "source_signer_mismatch" &&
      owner &&
      me &&
      this.live !== undefined &&
      deps.allowSigner
    ) {
      actions.push(ALLOW_THIS_WORKSTATION);
    }
    const where = placed.length > 0 ? " See Problems." : "";
    const message = `Airdress: ${name} — ${this.step} refused (${refusal.error}): ${refusal.message}.${where}`;
    const choice = await deps.ui.warn(message, ...actions);
    if (choice === WIDEN_GRANT && this.live) {
      await deps.openDraft(widenGrantDraft(this.live, refusal));
    } else if (choice === ALLOW_THIS_WORKSTATION && me && deps.allowSigner) {
      await deps.allowSigner(this.profile, name, me);
    }
    if (this.step === "check") {
      return { kind: "stopped", code: "check_failed", message, refusal };
    }
    return { kind: "refused", step: this.step, refusal };
  }

  stopped(stop: DeployStop): DeployOutcome {
    if (stop.code !== "signer_not_this_client") {
      // The not-a-signer stop already said so, with its action.
      this.deps.ui.error(stop.message);
    }
    return {
      kind: "stopped",
      code: stop.code,
      message: stop.message,
      refusal: stop.refusal,
    };
  }
}

/** The create manifest with its version filled in. */
function withVersion(
  manifest: FunctionManifest,
  version: string,
): FunctionManifest {
  const source = isRecord(manifest.spec.source) ? manifest.spec.source : {};
  return {
    ...manifest,
    spec: { ...manifest.spec, source: { ...source, version } },
  };
}

/**
 * "Widen the grant…": the live manifest as a draft, with every capability
 * the check refused named above it. The owner edits the grant and
 * applies it with Apply Manifest, which asks on its own — Deploy never
 * widens a grant.
 */
export function widenGrantDraft(
  live: LiveFunction,
  refusal: SourceRefusal,
): string {
  const header = [
    `# ${live.name} asks for capabilities its grant does not give it.`,
    "# Change spec.capabilities below, then run Airdress: Apply Manifest to",
    "# Operator. That apply is the grant decision; Deploy never makes it.",
    "#",
    ...refusal.denials.map(
      (d) => `#   ${d.capability}: ${d.detail} (grant path ${d.grantPath})`,
    ),
    "",
  ].join("\n");
  return header + manifestYaml(manifestFrom(live, live.spec));
}

/** A condition from `status.conditions[]`. */
interface Condition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
}

function conditionOf(
  status: Record<string, unknown>,
  type: string,
): Condition | undefined {
  if (!Array.isArray(status.conditions)) {
    return undefined;
  }
  const found = status.conditions.find(
    (c) => isRecord(c) && c.type === type && typeof c.status === "string",
  ) as Record<string, unknown> | undefined;
  return found
    ? {
        type,
        status: found.status as string,
        reason: typeof found.reason === "string" ? found.reason : undefined,
        message: typeof found.message === "string" ? found.message : undefined,
      }
    : undefined;
}

/**
 * Step 7: poll the function until it reports the new version loaded, for
 * the generation the write created. 250 ms, backing off to 2 s. Answers
 * the elapsed time; stops with `load_failed` or `not_loaded_in_time`.
 */
export async function waitForLoaded(
  client: ApiClient,
  name: string,
  version: string,
  generation: number | undefined,
  progress: (message: string) => void,
  clock: Clock,
  timeoutMs: number,
): Promise<number> {
  const start = clock.now();
  let delay = 250;
  let saidCompiling = false;
  let saidRestart = false;
  for (;;) {
    let live: LiveFunction | undefined;
    try {
      live = await readLiveFunction(client, name);
    } catch {
      live = undefined;
    }
    if (!live) {
      if (!saidRestart) {
        saidRestart = true;
        progress("waiting for the operator to admit functions after a restart");
      }
    } else {
      const want = generation ?? live.generation ?? 0;
      const observed = live.observedGeneration;
      const loaded = conditionOf(live.status, "Loaded");
      if (observed !== undefined && observed >= want) {
        if (loaded?.status === "False") {
          throw new DeployStop(
            "load_failed",
            `Airdress: ${name} is promoted to ${shortVersion(version)} but did not load — ${loaded.reason ?? "no reason given"}${loaded.message ? `: ${loaded.message}` : ""}.`,
          );
        }
        const serving = live.status.sourceVersion;
        if (
          loaded?.status === "True" &&
          (serving === undefined || serving === version)
        ) {
          return clock.now() - start;
        }
      }
    }
    const elapsed = clock.now() - start;
    if (elapsed >= timeoutMs) {
      throw new DeployStop(
        "not_loaded_in_time",
        `Airdress: ${name} gave no verdict within ${Math.round(timeoutMs / 1000)} s. ` +
          `${shortVersion(version)} is already the version it should run; read its status and log.`,
      );
    }
    if (elapsed >= 2000 && !saidCompiling) {
      saidCompiling = true;
      progress(
        "compiling — the first function after an operator deploy compiles the engine (≈ 15 s)",
      );
    }
    await clock.sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

/**
 * The grant a tree asks for: each `function.json` capability
 * (`airdress:fn/<name>@<version>`) as `{ <name>: {} }`. Unreadable or
 * absent yields none; the operator's check says why.
 */
export function requestedCapabilities(
  tree: SourceTree,
): Record<string, Record<string, never>> {
  const caps: Record<string, Record<string, never>> = {};
  const bytes = tree.get("function.json");
  if (!bytes) {
    return caps;
  }
  let fj: unknown;
  try {
    fj = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return caps;
  }
  const list =
    isRecord(fj) && Array.isArray(fj.capabilities) ? fj.capabilities : [];
  for (const c of list) {
    const full = isRecord(c) && typeof c.name === "string" ? c.name : "";
    const short = full.replace(/^airdress:fn\//, "").split("@")[0];
    if (short) {
      caps[short] = {};
    }
  }
  return caps;
}
