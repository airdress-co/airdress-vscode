import { isJwtShaped } from "./bearer";

/**
 * Break-glass visibility — VISIBLE, never actionable.
 *
 * An OWNER session running on an operator-issued opaque bearer is a
 * break-glass session: the routine owner path is an OIDC sign-in, and
 * the opaque owner token is the on-the-box recovery credential. It
 * should look temporary, because it is meant to be — so it renders in
 * the status bar, with a one-click route to the recovery runbook.
 *
 * What this module deliberately does NOT contain: any way to MINT an
 * owner token. That is a host-shell operation whose security property
 * is that it requires being on the box; a network client that could
 * mint one would convert a possession-bound credential into a
 * reachable one. A test pins this absence.
 *
 * The indicator shows the credential's SHAPE, never any part of its
 * value.
 */

export type BreakGlassState =
  /** Owner on an opaque bearer — the loud, temporary state. */
  | "break-glass"
  /** Anything else: OIDC session, sub-user bearer, unknown ownership. */
  | "normal";

export interface BreakGlassInput {
  authMode: "zitadel" | "bearer";
  /**
   * The stored bearer's shape (three dot-segments = JWT-shaped), or
   * undefined when no bearer is stored. Computed via classifyBearer —
   * the VALUE never travels past that call.
   */
  bearerShape?: "jwt" | "opaque";
  /**
   * Ownership as last probed. undefined = not yet known; an unknown
   * owner state must NOT claim break-glass.
   */
  isOwner?: boolean;
}

/** Reduce a stored bearer to its shape; the value goes no further. */
export function classifyBearer(
  token: string | undefined,
): "jwt" | "opaque" | undefined {
  if (token === undefined) {
    return undefined;
  }
  return isJwtShaped(token) ? "jwt" : "opaque";
}

export function breakGlassState(input: BreakGlassInput): BreakGlassState {
  if (
    input.authMode === "bearer" &&
    input.bearerShape === "opaque" &&
    input.isOwner === true
  ) {
    return "break-glass";
  }
  return "normal";
}

/** Status-bar text for a break-glass session (shape only, no value). */
export function breakGlassText(fqdn: string): string {
  return `$(key) ${fqdn} — break-glass`;
}

export function breakGlassTooltip(fqdn: string): string {
  return (
    `This owner session on ${fqdn} uses an operator-issued opaque ` +
    "bearer — a break-glass credential meant to be temporary. Click " +
    "for the owner-token recovery runbook (how to get back to a " +
    "routine sign-in). This extension cannot mint owner tokens; that " +
    "requires being on the operator's host, by design."
  );
}
