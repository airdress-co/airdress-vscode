/**
 * Opaque operator-bearer entry.
 *
 * Mirrors the operator's `auth::bearer::is_jwt_shaped` predicate (SPEC-045)
 * for one purpose only: telling the user, at paste time, which credential
 * they appear to have handed over. It never branches behaviour — the
 * operator decides; a divergence between the two copies degrades a hint,
 * not correctness (design §4.4).
 */

/** Three non-empty `.`-separated segments — the SPEC-045 shape check. */
export function isJwtShaped(token: string): boolean {
  const segments = token.split(".");
  return segments.length === 3 && segments.every((s) => s.length > 0);
}

/**
 * Prompt for an opaque bearer token and store it for the profile.
 *
 * TODO(SPEC-057 T6-04): input box with paste-time hint via isJwtShaped,
 * persisted through auth/store.ts.
 */
export async function enterBearer(): Promise<void> {
  throw new Error("TODO(SPEC-057 T6-04): bearer entry not implemented");
}
