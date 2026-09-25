import type { ApiClient } from "../api/client";
import type { SigningChoice } from "./local";

/**
 * Who may sign a function's source: its signer set.
 *
 * A Function's `spec.source` names who may sign in one of three ways.
 * `signers: [{ key } | { machine }]` is a set, any member of which may
 * sign. The older single forms, `signer: <key>` and
 * `signerRef: { machine }`, each mean a set of one. This editor reads
 * all three and writes only the set form.
 *
 * The operator decides membership, at publish, at promote and when it
 * loads a version. The test here only lets the editor stop early with a
 * sentence instead of a refusal, and list who IS allowed.
 */

/** One member of the set: a key, or an approved machine. */
export type SignerMember =
  { readonly key: string } | { readonly machine: string };

/** The operator's limit on the set's size. */
export const MAX_SIGNERS = 16;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a member is a key member. */
export function isKeyMember(m: SignerMember): m is { readonly key: string } {
  return "key" in m;
}

/**
 * The set a `spec.source` names, whichever form it is written in. Empty
 * means unsigned, which an operator admits only when it allows unsigned
 * source.
 */
export function allowedSigners(source: unknown): SignerMember[] {
  if (!isRecord(source)) {
    return [];
  }
  if (Array.isArray(source.signers)) {
    return source.signers.flatMap((m): SignerMember[] => {
      if (!isRecord(m)) {
        return [];
      }
      if (typeof m.key === "string") {
        return [{ key: m.key }];
      }
      if (typeof m.machine === "string") {
        return [{ machine: m.machine }];
      }
      return [];
    });
  }
  if (typeof source.signer === "string") {
    return [{ key: source.signer }];
  }
  if (
    isRecord(source.signerRef) &&
    typeof source.signerRef.machine === "string"
  ) {
    return [{ machine: source.signerRef.machine }];
  }
  return [];
}

/** Two members name the same signer. Keys compare case-folded. */
export function sameMember(a: SignerMember, b: SignerMember): boolean {
  if (isKeyMember(a) && isKeyMember(b)) {
    return a.key.toLowerCase() === b.key.toLowerCase();
  }
  if (!isKeyMember(a) && !isKeyMember(b)) {
    return a.machine.toLowerCase() === b.machine.toLowerCase();
  }
  return false;
}

/**
 * The member this editor signs as: the machine when one is configured
 * (the key is then that machine's registered key), else the key.
 */
export function thisClientMember(
  signing: SigningChoice,
): SignerMember | undefined {
  if (signing.machine) {
    return { machine: signing.machine };
  }
  return signing.key ? { key: signing.key.publicKeyHex } : undefined;
}

/**
 * Whether this editor's signer is in the set. A machine is named by
 * name or id; the editor compares what it was told and leaves the
 * resolution between the two to the operator.
 */
export function isMember(
  set: readonly SignerMember[],
  signing: SigningChoice,
  machines: readonly MachineInfo[] = [],
): boolean {
  const me = thisClientMember(signing);
  if (!me) {
    return false;
  }
  if (isKeyMember(me)) {
    return set.some((m) => sameMember(m, me));
  }
  const aliases = machineAliases(me.machine, machines);
  return set.some(
    (m) => !isKeyMember(m) && aliases.has(m.machine.toLowerCase()),
  );
}

/** A machine's id and name, lowercased, as either may be written. */
function machineAliases(
  machine: string,
  machines: readonly MachineInfo[],
): Set<string> {
  const lower = machine.toLowerCase();
  const found = machines.find(
    (m) => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower,
  );
  return new Set(
    found ? [found.id.toLowerCase(), found.name.toLowerCase(), lower] : [lower],
  );
}

/** `5c1e…a07b`: enough of a key to tell two apart, as both clients print it. */
export function shortKey(hex: string): string {
  const h = hex.toLowerCase();
  return h.length > 8 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h;
}

/** An enrolled machine, as `GET /v1/admin/machines` lists it. */
export interface MachineInfo {
  readonly id: string;
  readonly name: string;
  readonly fingerprint?: string;
  readonly revoked: boolean;
  readonly approved: boolean;
}

/**
 * `GET /v1/admin/machines` — the owner's list. It answers only to the
 * owner's own sign-in, and only on an operator that enrolls machines;
 * any failure is an empty list, and a machine is then shown by the id
 * the manifest carries.
 */
export async function listMachines(client: ApiClient): Promise<MachineInfo[]> {
  let body: unknown;
  try {
    body = await client.request<unknown>("/v1/admin/machines");
  } catch {
    return [];
  }
  if (!isRecord(body) || !Array.isArray(body.machines)) {
    return [];
  }
  return body.machines.flatMap((m): MachineInfo[] => {
    if (!isRecord(m) || typeof m.machine_id !== "string") {
      return [];
    }
    return [
      {
        id: m.machine_id,
        name: typeof m.name === "string" ? m.name : m.machine_id,
        fingerprint:
          typeof m.fingerprint === "string" ? m.fingerprint : undefined,
        revoked: typeof m.revoked_at === "string",
        approved: typeof m.approved_at === "string",
      },
    ];
  });
}

/** One member in words: `key 5c1e…a07b (this workstation)`, `machine ci`. */
export function describeMember(
  m: SignerMember,
  machines: readonly MachineInfo[] = [],
  signing?: SigningChoice,
): string {
  if (isKeyMember(m)) {
    const mine =
      signing?.key &&
      signing.key.publicKeyHex.toLowerCase() === m.key.toLowerCase();
    return `key ${shortKey(m.key)}${mine ? " (this workstation)" : ""}`;
  }
  const lower = m.machine.toLowerCase();
  const found = machines.find(
    (x) => x.id.toLowerCase() === lower || x.name.toLowerCase() === lower,
  );
  if (!found) {
    return `machine ${m.machine}`;
  }
  const state = found.revoked ? ", revoked" : "";
  return found.name.toLowerCase() === lower
    ? `machine ${found.name}${state}`
    : `machine ${found.name} (${found.id}${state})`;
}

/** The whole set in words, or what an empty one means. */
export function describeSet(
  set: readonly SignerMember[],
  machines: readonly MachineInfo[] = [],
  signing?: SigningChoice,
): string {
  return set.length === 0
    ? "nobody (unsigned source only)"
    : set.map((m) => describeMember(m, machines, signing)).join(", ");
}

/** Who signed a stored version: its key, and its machine if any. */
export interface VersionSigner {
  readonly key?: string;
  readonly machine?: string;
}

/**
 * Who signed the running version. The operator's status says so
 * (`status.sourceSigner`) where it reports it; otherwise the stored
 * version's own record does (`signer`, `signerRef`).
 */
export function versionSigner(
  status: unknown,
  version: unknown,
): VersionSigner | undefined {
  if (isRecord(status) && isRecord(status.sourceSigner)) {
    const s = status.sourceSigner;
    const key = typeof s.key === "string" ? s.key : undefined;
    const machine = typeof s.machine === "string" ? s.machine : undefined;
    if (key || machine) {
      return { key, machine };
    }
  }
  if (isRecord(version)) {
    const key = typeof version.signer === "string" ? version.signer : undefined;
    const machine =
      typeof version.signerRef === "string" ? version.signerRef : undefined;
    if (key || machine) {
      return { key, machine };
    }
  }
  return undefined;
}

/** A version's signer in words. */
export function describeVersionSigner(
  s: VersionSigner,
  machines: readonly MachineInfo[] = [],
): string {
  if (s.machine) {
    return describeMember({ machine: s.machine }, machines);
  }
  return s.key ? `key ${shortKey(s.key)}` : "nobody (unsigned)";
}

/**
 * Whether a member is the one that signed a version: the same key, or
 * the machine it was published under.
 */
export function memberSigned(
  m: SignerMember,
  s: VersionSigner,
  machines: readonly MachineInfo[] = [],
): boolean {
  if (isKeyMember(m)) {
    return !!s.key && s.key.toLowerCase() === m.key.toLowerCase();
  }
  if (!s.machine) {
    return false;
  }
  const aliases = machineAliases(m.machine, machines);
  return aliases.has(s.machine.toLowerCase());
}

/** A set change that cannot be made, in a sentence. */
export class SignerSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerSetError";
  }
}

/**
 * `spec.source` with one member added, in the set form. A single form is
 * converted: `signer: K` becomes `signers: [{ key: K }, <new>]`. Every
 * other field of `source` is kept as it was.
 */
export function sourceWithMember(
  source: Record<string, unknown>,
  member: SignerMember,
): Record<string, unknown> {
  const set = allowedSigners(source);
  if (set.some((m) => sameMember(m, member))) {
    throw new SignerSetError(
      `${describeMember(member)} is already allowed to sign.`,
    );
  }
  if (set.length >= MAX_SIGNERS) {
    throw new SignerSetError(
      `a function allows at most ${MAX_SIGNERS} signers, and this one has ${set.length}.`,
    );
  }
  return withSet(source, [...set, member]);
}

/**
 * `spec.source` with one member removed. Removing the last one is
 * refused: an empty set is not "anybody", it is "unsigned only", and a
 * change that large is written by hand.
 */
export function sourceWithoutMember(
  source: Record<string, unknown>,
  member: SignerMember,
): Record<string, unknown> {
  const set = allowedSigners(source);
  const rest = set.filter((m) => !sameMember(m, member));
  if (rest.length === set.length) {
    throw new SignerSetError(`${describeMember(member)} is not in the set.`);
  }
  if (rest.length === 0) {
    throw new SignerSetError(
      "that is the only signer; a function with none accepts only unsigned source. " +
        "Allow another signer first.",
    );
  }
  return withSet(source, rest);
}

/** `source` in the set form, the single forms dropped. */
export function withSet(
  source: Record<string, unknown>,
  set: readonly SignerMember[],
): Record<string, unknown> {
  const rest = Object.fromEntries(
    Object.entries(source).filter(
      ([k]) => k !== "signer" && k !== "signerRef" && k !== "signers",
    ),
  );
  return {
    ...rest,
    signers: set.map((m) =>
      isKeyMember(m) ? { key: m.key.toLowerCase() } : { machine: m.machine },
    ),
  };
}
