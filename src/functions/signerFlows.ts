import type { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import { signerSetConfirm, targetPhrase } from "../profiles/confirm";
import {
  applyFunction,
  manifestFrom,
  readLiveFunction,
  type LiveFunction,
} from "./functionManifest";
import type { SigningChoice } from "./local";
import {
  allowedSigners,
  describeMember,
  describeVersionSigner,
  isKeyMember,
  listMachines,
  memberSigned,
  shortKey,
  SignerSetError,
  sourceWithMember,
  sourceWithoutMember,
  versionSigner,
  type MachineInfo,
  type SignerMember,
} from "./signers";
import { readVersion } from "./wire";

/**
 * Changing who may sign a function: "Allow another signer…" and
 * "Remove signer…".
 *
 * Each is its own apply, by the owner, of the live manifest with one
 * member added or removed and nothing else changed — never part of a
 * Deploy, and never sent before the resulting set has been shown. The
 * apply carries the resource version it read, so a manifest someone
 * changed in between is refused rather than overwritten.
 */

export interface SignerFlowUI {
  pick<T extends { label: string }>(
    items: T[],
    placeHolder: string,
  ): Thenable<T | undefined>;
  ask(
    prompt: string,
    validate?: (value: string) => string | undefined,
  ): Thenable<string | undefined>;
  choose(
    message: string,
    detail: string,
    ...actions: string[]
  ): Thenable<string | undefined>;
  info(message: string): void;
  error(message: string): void;
}

export interface SignerFlowDeps {
  client(profile: Profile): ApiClient;
  signing(): Promise<SigningChoice>;
  /** Make this workstation's key, when it has none. */
  createKey(): Promise<SigningChoice>;
  ui: SignerFlowUI;
}

export type SignerFlowOutcome = "applied" | "cancelled" | "failed";

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The live source function, or a sentence saying why there is none. */
async function readSourceFunction(
  deps: SignerFlowDeps,
  client: ApiClient,
  name: string,
): Promise<
  { live: LiveFunction; source: Record<string, unknown> } | undefined
> {
  const live = await readLiveFunction(client, name);
  if (!live) {
    deps.ui.error(`Airdress: there is no Function named ${name}.`);
    return undefined;
  }
  if (!isRecord(live.spec.source)) {
    deps.ui.error(
      `Airdress: ${name} runs a WebAssembly bundle; a signer set belongs to a source function.`,
    );
    return undefined;
  }
  return { live, source: live.spec.source };
}

/** Ask which signer to add: this workstation, a pasted key, or a machine. */
async function pickMember(
  deps: SignerFlowDeps,
  machines: readonly MachineInfo[],
): Promise<SignerMember | undefined> {
  const signing = await deps.signing();
  const items: Array<{ label: string; detail: string; id: string }> = [
    {
      label: "This workstation's key",
      detail: signing.key
        ? `key ${shortKey(signing.key.publicKeyHex)} — the key this editor signs with`
        : "This editor has no key yet; one is made and kept in the keychain.",
      id: "self",
    },
    {
      label: "A key, pasted",
      detail: "Another workstation's public key: 64 hex characters.",
      id: "paste",
    },
  ];
  const enrolled = machines.filter((m) => m.approved && !m.revoked);
  if (enrolled.length > 0) {
    items.push({
      label: "An enrolled machine",
      detail: "A CI runner or another machine this operator has approved.",
      id: "machine",
    });
  }
  const picked = await deps.ui.pick(
    items,
    "Who else may deploy this function?",
  );
  switch (picked?.id) {
    case "self": {
      const key = signing.key ?? (await deps.createKey()).key;
      return key ? { key: key.publicKeyHex } : undefined;
    }
    case "paste": {
      const text = await deps.ui.ask(
        "The public key to allow (64 hex characters)",
        (v) =>
          HEX_KEY.test(v.trim())
            ? undefined
            : "A public key is 64 hex characters.",
      );
      return text ? { key: text.trim().toLowerCase() } : undefined;
    }
    case "machine": {
      const machine = await deps.ui.pick(
        enrolled.map((m) => ({
          label: m.name,
          description: m.fingerprint,
          detail: m.id,
          id: m.id,
        })),
        "Which machine?",
      );
      return machine ? { machine: machine.id } : undefined;
    }
    default:
      return undefined;
  }
}

/** Send the changed manifest; its own apply. */
async function applySet(
  deps: SignerFlowDeps,
  client: ApiClient,
  live: LiveFunction,
  source: Record<string, unknown>,
  profile: Profile,
): Promise<SignerFlowOutcome> {
  try {
    await applyFunction(client, manifestFrom(live, { ...live.spec, source }));
  } catch (err) {
    deps.ui.error(
      `Airdress: changing the signers of ${live.name} on ${targetPhrase(profile)} failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "failed";
  }
  return "applied";
}

/**
 * "Allow another signer…". `preset` skips the question — "Allow this
 * workstation…" after a Deploy was refused for it.
 */
export async function allowAnotherSigner(
  deps: SignerFlowDeps,
  profile: Profile,
  name: string,
  preset?: SignerMember,
): Promise<SignerFlowOutcome> {
  const client = deps.client(profile);
  const found = await readSourceFunction(deps, client, name);
  if (!found) {
    return "failed";
  }
  const machines = await listMachines(client);
  const member = preset ?? (await pickMember(deps, machines));
  if (!member) {
    return "cancelled";
  }
  let next: Record<string, unknown>;
  try {
    next = sourceWithMember(found.source, member);
  } catch (err) {
    if (err instanceof SignerSetError) {
      deps.ui.error(`Airdress: ${name} — ${err.message}`);
      return "failed";
    }
    throw err;
  }
  const signing = await deps.signing();
  const text = signerSetConfirm(
    {
      name,
      change: `Allow ${describeMember(member, machines, signing)} to sign`,
      resulting: allowedSigners(next).map((m) =>
        describeMember(m, machines, signing),
      ),
    },
    profile,
  );
  if ((await deps.ui.choose(text.message, text.detail, "Allow")) !== "Allow") {
    return "cancelled";
  }
  const outcome = await applySet(deps, client, found.live, next, profile);
  if (outcome === "applied") {
    deps.ui.info(
      `Airdress: ${describeMember(member, machines, signing)} may now deploy ${name}.`,
    );
  }
  return outcome;
}

/**
 * "Remove signer…". Warns, naming the running version, when the member
 * removed is the one that signed it: the operator will not load that
 * version again once its signer is out of the set.
 */
export async function removeSigner(
  deps: SignerFlowDeps,
  profile: Profile,
  name: string,
): Promise<SignerFlowOutcome> {
  const client = deps.client(profile);
  const found = await readSourceFunction(deps, client, name);
  if (!found) {
    return "failed";
  }
  const machines = await listMachines(client);
  const signing = await deps.signing();
  const set = allowedSigners(found.source);
  if (set.length === 0) {
    deps.ui.info(`Airdress: ${name} names no signer.`);
    return "cancelled";
  }
  const picked = await deps.ui.pick(
    set.map((m, i) => ({
      label: describeMember(m, machines, signing),
      i,
    })),
    `Remove which signer of ${name}?`,
  );
  if (!picked) {
    return "cancelled";
  }
  const member = set[picked.i];
  let next: Record<string, unknown>;
  try {
    next = sourceWithoutMember(found.source, member);
  } catch (err) {
    if (err instanceof SignerSetError) {
      deps.ui.error(`Airdress: ${name} — ${err.message}`);
      return "failed";
    }
    throw err;
  }
  let warning: string | undefined;
  const running =
    typeof found.source.version === "string" ? found.source.version : undefined;
  if (running) {
    let info: unknown;
    try {
      info = await readVersion(client, running);
    } catch {
      info = undefined;
    }
    const signer = versionSigner(found.live.status, info);
    if (signer && memberSigned(member, signer, machines)) {
      warning =
        `${describeMember(member, machines, signing)} signed the version ${name} runs now ` +
        `(${running}, signed by ${describeVersionSigner(signer, machines)}). ` +
        "Once it is removed, the operator refuses to load that version again — " +
        "deploy a version signed by a remaining member first, or keep this one.";
    }
  }
  const text = signerSetConfirm(
    {
      name,
      change: `Remove ${describeMember(member, machines, signing)} as a signer`,
      resulting: allowedSigners(next).map((m) =>
        describeMember(m, machines, signing),
      ),
      warning,
    },
    profile,
  );
  if (
    (await deps.ui.choose(text.message, text.detail, "Remove")) !== "Remove"
  ) {
    return "cancelled";
  }
  const outcome = await applySet(deps, client, found.live, next, profile);
  if (outcome === "applied") {
    deps.ui.info(
      `Airdress: ${describeMember(member, machines, signing)} may no longer deploy ${name}.` +
        (isKeyMember(member)
          ? " Versions it signed stay stored; revoke the key itself to quarantine them."
          : ""),
    );
  }
  return outcome;
}
