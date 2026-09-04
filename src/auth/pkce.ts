import * as crypto from "node:crypto";

/**
 * PKCE (RFC 7636) helpers — S256 only.
 *
 * Pure functions over node:crypto so the derivation is unit-testable
 * against the RFC 7636 appendix vectors (verify values, not presence:
 * verify the challenge VALUE, not merely that one is present).
 */

/** RFC 7636 §4.1 unreserved characters for a code verifier. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Generate a code verifier: 32 random bytes, base64url without padding —
 * 43 characters, all from the RFC 7636 unreserved set.
 */
export function generateVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Whether a string is a legal RFC 7636 code verifier. */
export function isValidVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

/**
 * Derive the S256 code challenge:
 * BASE64URL-ENCODE(SHA256(ASCII(code_verifier))), no padding (RFC 7636 §4.2).
 */
export function challengeS256(verifier: string): string {
  return crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
}

/** Opaque CSRF `state` value for the authorization request. */
export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}
