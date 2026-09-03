/** How a profile authenticates against its operator. */
export type AuthMode = "zitadel" | "bearer";

/**
 * An operator profile (design §3.3).
 *
 * `fqdn` is the SPEC-029 `<uuid>.a.airdr.es` form — raw IPs bypass the
 * relay TLS path and are rejected at validation time (FR-25).
 */
export interface Profile {
  id: string;
  label: string;
  fqdn: string;
  authMode: AuthMode;
  /** Development profile: relaxes TLS expectations for local operators. */
  dev: boolean;
}
