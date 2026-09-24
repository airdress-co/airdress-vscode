/**
 * Who a credential belongs to.
 *
 * A person can hold several accounts, and the browser that runs the
 * sign-in holds sessions this extension cannot see. So a profile binds
 * to an identity, and every later credential for that profile is
 * checked against it — asking the identity provider nicely with
 * `prompt` is a request, never a guarantee.
 *
 * SECURITY: nothing here validates a signature, and nothing here may be
 * used to decide authorization. The id token is read only for the two
 * display-and-compare fields below; the operator validates the ACCESS
 * token on every request, which is what actually decides anything.
 * Reading it is safe for that purpose because it came straight from the
 * issuer's token endpoint over TLS in exchange for a PKCE-bound code
 * (OIDC Core §3.1.3.7 case 1), not from a redirect or a third party.
 */
export interface AccountIdentity {
  /** The issuer's subject: stable, opaque, and the only thing compared. */
  sub: string;
  /**
   * What to show a person — `preferred_username`, else `email`, else
   * `name`. It can change under the same subject, so it is never
   * compared and never stored as the binding.
   */
  label?: string;
}

/** Longest label kept; anything beyond this is an oversized claim. */
const LABEL_MAX = 254;

function decodeSegment(segment: string): unknown {
  const padded = segment.padEnd(
    segment.length + ((4 - (segment.length % 4)) % 4),
    "=",
  );
  const json = Buffer.from(padded, "base64url").toString("utf8");
  return JSON.parse(json);
}

/**
 * Read the identity out of an id token (pure; unit-tested).
 *
 * Returns undefined for anything that is not a JWT-shaped token with a
 * non-empty string `sub` — a missing identity is an absent binding, and
 * an absent binding never silently becomes a match.
 */
export function identityFromIdToken(
  idToken: string | undefined,
): AccountIdentity | undefined {
  if (!idToken) {
    return undefined;
  }
  const segments = idToken.split(".");
  if (segments.length !== 3 || segments.some((s) => s.length === 0)) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = decodeSegment(segments[1]);
  } catch {
    return undefined;
  }
  if (typeof claims !== "object" || claims === null) {
    return undefined;
  }
  const record = claims as Record<string, unknown>;
  const sub = record.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    return undefined;
  }
  const label = [record.preferred_username, record.email, record.name]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .find((v) => v.length <= LABEL_MAX);
  return label === undefined ? { sub } : { sub, label };
}

/** How an identity reads in a message: the label, else the subject. */
export function identityText(identity: AccountIdentity | undefined): string {
  if (!identity) {
    return "an unknown account";
  }
  return identity.label ?? identity.sub;
}

/** Raised when a credential belongs to an account the profile does not. */
export class AccountMismatchError extends Error {
  constructor(
    readonly expected: AccountIdentity,
    readonly got: AccountIdentity,
  ) {
    super(
      `That sign-in returned ${identityText(got)}, but this profile is ` +
        `signed in as ${identityText(expected)}. Nothing was changed — ` +
        `sign in again and pick ${identityText(expected)}, or add a ` +
        `separate profile for the other account.`,
    );
    this.name = "AccountMismatchError";
  }
}
