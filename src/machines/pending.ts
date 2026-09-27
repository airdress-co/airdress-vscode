import { ApiError, type ApiClient } from "../api/client";

/**
 * Machines waiting for the owner: the pending-enrollment listing, and
 * the bodies that approve or deny one.
 *
 * A machine enrolls by holding a key and asking; it is admitted only
 * when the owner approves it, and approval is a COMPARISON: the machine
 * prints a confirmation code (or, on an older operator, only its key's
 * fingerprint), and the owner checks that what the operator holds is
 * what the machine shows. The approve body therefore always carries
 * what was compared — there is no body that approves without one.
 *
 * These routes answer only to the owner's own OIDC sign-in. Everything
 * in this file is free of `vscode` so the tests can hold the wire
 * shapes directly.
 */

/** A link the owner can attach at approval: `{kind, name}`. */
export interface MachineLink {
  readonly kind: "Home";
  readonly name: string;
}

/** One pending enrollment, as `GET /v1/admin/machines/enrollments` lists it. */
export interface PendingEnrollment {
  readonly userCode: string;
  readonly name: string;
  readonly fingerprint: string;
  /** `new`, or `reauth` for a known machine presenting a new key. */
  readonly kind: string;
  /** Set for a reauth: the machine it re-keys. */
  readonly machineId?: string;
  /** Absent on an operator that predates confirmation codes. */
  readonly confirmationCode?: string;
  /** What the machine says it is for, e.g. `home-assistant`. */
  readonly purpose?: string;
  /** Kinds it may be linked as at approval; an older operator sends none. */
  readonly links: readonly string[];
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The listing, decoded defensively. A row without a user code or a
 * fingerprint cannot be compared and so cannot be approved here; it is
 * dropped rather than shown with a button that would fail.
 */
export function parsePendingListing(body: unknown): PendingEnrollment[] {
  if (!isRecord(body) || !Array.isArray(body.enrollments)) {
    return [];
  }
  return body.enrollments.flatMap((r): PendingEnrollment[] => {
    if (!isRecord(r)) {
      return [];
    }
    const userCode = str(r.user_code);
    const fingerprint = str(r.fingerprint);
    if (!userCode || !fingerprint) {
      return [];
    }
    return [
      {
        userCode,
        name: str(r.name) ?? userCode,
        fingerprint,
        kind: str(r.kind) ?? "new",
        machineId: str(r.machine_id),
        confirmationCode: str(r.confirmation_code),
        purpose: str(r.purpose),
        links: Array.isArray(r.links)
          ? r.links.filter((l): l is string => typeof l === "string")
          : [],
        createdAt: str(r.created_at),
        expiresAt: str(r.expires_at),
      },
    ];
  });
}

/** `GET /v1/admin/machines/enrollments`. Errors propagate to the caller. */
export async function listPendingEnrollments(
  client: ApiClient,
): Promise<PendingEnrollment[]> {
  return parsePendingListing(
    await client.request<unknown>("/v1/admin/machines/enrollments"),
  );
}

/**
 * Whether approval may also link this machine as Home. Only when the
 * operator advertised it for THIS enrollment: an operator that does not
 * know `link` refuses the whole body, so it is never sent unasked.
 */
export function offersHomeLink(e: PendingEnrollment): boolean {
  return e.links.includes("Home");
}

/** The operator's rule for a link name: a DNS label, lowercase. */
export const LINK_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The name suggested for a Home link. */
export const DEFAULT_HOME_NAME = "home";

/** Why a link name is refused, or undefined when it is fine. */
export function linkNameProblem(name: string): string | undefined {
  return LINK_NAME_PATTERN.test(name)
    ? undefined
    : "Lowercase letters, digits and hyphens, 1–63 characters, not starting or ending with a hyphen.";
}

/** What the owner compared: the code when there is one, else the key. */
export function comparedValue(e: PendingEnrollment): {
  readonly field: "confirmation_code" | "fingerprint";
  readonly value: string;
} {
  return e.confirmationCode
    ? { field: "confirmation_code", value: e.confirmationCode }
    : { field: "fingerprint", value: e.fingerprint };
}

/** A body that cannot be built, in a sentence. */
export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * The approve body: exactly one of `confirmation_code` / `fingerprint`,
 * plus `link` only when asked for AND advertised.
 */
export function approvalBody(
  e: PendingEnrollment,
  link?: MachineLink,
): Record<string, unknown> {
  const { field, value } = comparedValue(e);
  const body: Record<string, unknown> = { [field]: value };
  if (link) {
    if (!e.links.includes(link.kind)) {
      throw new ApprovalError(
        `this operator does not offer linking '${e.name}' as ${link.kind}.`,
      );
    }
    const problem = linkNameProblem(link.name);
    if (problem) {
      throw new ApprovalError(
        `'${link.name}' is not a usable name. ${problem}`,
      );
    }
    body.link = { kind: link.kind, name: link.name };
  }
  return body;
}

/** The path for one enrollment's verb. */
export function enrollmentPath(
  userCode: string,
  verb: "approve" | "deny",
): string {
  return `/v1/admin/machines/enrollments/${encodeURIComponent(userCode)}/${verb}`;
}

/** What the operator answered to an approval. */
export interface ApprovalResult {
  readonly machineId?: string;
  readonly name?: string;
  readonly link?: MachineLink;
}

/** `POST …/approve` with the compared value and an optional link. */
export async function approveEnrollment(
  client: ApiClient,
  e: PendingEnrollment,
  link?: MachineLink,
): Promise<ApprovalResult> {
  const body = approvalBody(e, link);
  const response = await client.request<unknown>(
    enrollmentPath(e.userCode, "approve"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!isRecord(response)) {
    return {};
  }
  const l = response.link;
  return {
    machineId: str(response.machine_id),
    name: str(response.name),
    link:
      isRecord(l) && l.kind === "Home" && typeof l.name === "string"
        ? { kind: "Home", name: l.name }
        : undefined,
  };
}

/** `POST …/deny`, no body. */
export async function denyEnrollment(
  client: ApiClient,
  e: PendingEnrollment,
): Promise<void> {
  await client.request<undefined>(enrollmentPath(e.userCode, "deny"), {
    method: "POST",
  });
}

/** The `error.code` of a machines-admin refusal, if it carries one. */
export function machineErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || !isRecord(err.body)) {
    return undefined;
  }
  const e = err.body.error;
  if (isRecord(e) && typeof e.code === "string") {
    return e.code;
  }
  return typeof e === "string" ? e : undefined;
}

/**
 * A refusal in plain words. Every sentence says what did NOT happen,
 * because on each of these the machine is not approved.
 */
export function describeMachineError(err: unknown, name: string): string {
  switch (machineErrorCode(err)) {
    case "confirmation_mismatch":
      return (
        `The operator holds a different key for '${name}' than the one compared. ` +
        "Nothing was approved. If the machine is yours, start its enrollment again; " +
        "if it is not, deny it."
      );
    case "confirmation_required":
      return `The operator needs the confirmation code or fingerprint to approve '${name}'. Nothing was approved.`;
    case "no_pending_enrollment":
      return `'${name}' is no longer waiting — it was already approved or denied, or its code is wrong. Refresh the list.`;
    case "enrollment_expired":
      return `The enrollment for '${name}' expired before it was approved. Start it again on the machine.`;
    case "link_unavailable":
      return `This operator cannot link '${name}' as Home, so nothing was approved. Approve it without the link, or link it later.`;
    case "invalid_request":
      return `The operator refused the request for '${name}' as malformed. Nothing was approved.`;
  }
  if (err instanceof ApiError && err.httpStatus === 403) {
    return "Only the owner's own sign-in may approve or deny machines on this operator.";
  }
  return err instanceof Error ? err.message : String(err);
}

/** Why the listing could not be read, in words, for the view. */
export function describeListingError(err: unknown): string {
  if (err instanceof ApiError && err.httpStatus === 404) {
    return "This operator does not enroll machines.";
  }
  if (err instanceof ApiError && err.httpStatus === 403) {
    return "Pending machines are shown only to the owner's own sign-in.";
  }
  return err instanceof Error ? err.message : String(err);
}

/** Whether an enrollment's window has passed, per `now`. */
export function isExpired(
  e: PendingEnrollment,
  now: Date = new Date(),
): boolean {
  if (!e.expiresAt) {
    return false;
  }
  const t = Date.parse(e.expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}
