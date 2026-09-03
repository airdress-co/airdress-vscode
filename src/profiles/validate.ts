/**
 * Profile FQDN validation (FR-25, SPEC-057 T6-03).
 *
 * Project-wide rule with a memory entry behind it: profile targets are
 * hostnames — the SPEC-029 `<uuid>.a.airdr.es` form or a custom domain.
 * Raw IP literals bypass the relay TLS path and behave differently from
 * what real clients do, so they are rejected by a test, not by
 * convention.
 *
 * `localhost` is the single dev-mode exception, accepted only when the
 * `airdress.dev.allowLocalhost` setting is on; the status bar surfaces
 * the dev state whenever such a profile is active.
 */

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export interface FqdnOptions {
  /** The `airdress.dev.allowLocalhost` setting. */
  allowLocalhost: boolean;
}

/** Whether the (already-validated) FQDN is the dev-mode localhost form. */
export function isLocalhost(fqdn: string): boolean {
  return fqdn.trim().toLowerCase() === "localhost";
}

/**
 * Validate a profile target. Returns an error message, or undefined
 * when the value is acceptable.
 */
export function validateFqdn(
  raw: string,
  opts: FqdnOptions,
): string | undefined {
  const fqdn = raw.trim();
  if (fqdn.length === 0) {
    return "Enter the operator's hostname (e.g. <uuid>.a.airdr.es).";
  }
  if (/[/?#]/.test(fqdn) || fqdn.includes("://")) {
    return "Enter a bare hostname — no scheme, path, or query (not a URL).";
  }
  if (fqdn.startsWith("[") || fqdn.endsWith("]")) {
    return "Bracketed IPv6 literals are not allowed — use the operator's airdress FQDN; raw addresses bypass the relay TLS path.";
  }
  if (fqdn.includes(":")) {
    // Catches raw IPv6 literals and host:port forms alike.
    return "Colons are not allowed — no ports, and no raw IPv6 literals; use the operator's airdress FQDN.";
  }
  if (IPV4_LITERAL.test(fqdn)) {
    return "Raw IPv4 literals are not allowed — use the operator's airdress FQDN; raw addresses bypass the relay TLS path.";
  }
  if (isLocalhost(fqdn)) {
    return opts.allowLocalhost
      ? undefined
      : "localhost is only allowed for development profiles — enable airdress.dev.allowLocalhost first.";
  }
  const labels = fqdn.split(".");
  if (labels.length < 2) {
    return "Enter a fully-qualified hostname (at least one dot).";
  }
  if (fqdn.length > 253 || !labels.every((l) => HOST_LABEL.test(l))) {
    return "Not a valid hostname.";
  }
  return undefined;
}
