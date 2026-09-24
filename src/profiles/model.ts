import type { AccountIdentity } from "../auth/identity";

/** How a profile authenticates against its operator. */
export type AuthMode = "zitadel" | "bearer";

/**
 * An operator profile (design §3.3).
 *
 * `fqdn` is the `<uuid>.a.airdr.es` form — raw IPs bypass the
 * relay TLS path and are rejected at validation time (FR-25).
 */
export interface Profile {
  id: string;
  label: string;
  fqdn: string;
  authMode: AuthMode;
  /** Development profile: relaxes TLS expectations for local operators. */
  dev: boolean;
  /**
   * Which account this profile is signed in as. Recorded at sign-in and
   * compared on every later one, so a profile cannot silently change
   * hands when the browser hands back a different session.
   *
   * Absent on profiles created before this was recorded, and on bearer
   * profiles, whose credential names no account. An absent binding is
   * NOT a wildcard — it is simply nothing to compare, and the first
   * sign-in that returns an identity fills it in.
   */
  account?: AccountIdentity;
}
