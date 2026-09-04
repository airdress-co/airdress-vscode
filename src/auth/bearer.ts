import * as vscode from "vscode";

/**
 * Opaque operator-bearer entry — the first-class alternative to the
 * ZITADEL flow (FR-20).
 *
 * Mirrors the operator's `auth::bearer::is_jwt_shaped` predicate
 * for one purpose only: telling the user, at paste time, which credential
 * they appear to have handed over. It never branches behaviour — the
 * operator decides; a divergence between the two copies degrades a hint,
 * not correctness (design §4.4).
 */

/** Three non-empty `.`-separated segments — the bearer shape check. */
export function isJwtShaped(token: string): boolean {
  const segments = token.split(".");
  return segments.length === 3 && segments.every((s) => s.length > 0);
}

/**
 * Paste-time hint (pure; unit-tested). Returns a warning string for a
 * JWT-shaped paste, undefined otherwise — the entry is never blocked.
 */
export function bearerPasteHint(token: string): string | undefined {
  if (isJwtShaped(token)) {
    // Deliberately a hint, not a validation error: the operator's
    // polymorphic Principal extractor accepts both shapes.
    return (
      "This looks like a ZITADEL (JWT) token, not an operator bearer — " +
      "the operator will decide, but double-check what you pasted."
    );
  }
  return undefined;
}

/**
 * Prompt for an opaque bearer token.
 *
 * Returns the raw token (to be persisted by auth/store.ts — the only
 * module that touches SecretStorage), or undefined if the user
 * cancelled. The token is masked in the input box and never logged.
 */
export async function promptForBearer(): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    title: "Airdress: Enter Operator Bearer Token",
    prompt:
      "Paste the operator-issued bearer token for this profile. " +
      "It is stored in the OS keychain and never written to settings.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return "Token must not be empty.";
      }
      const hint = bearerPasteHint(value.trim());
      // InputBox severity Warning: shown but does not block submission.
      return hint
        ? { message: hint, severity: vscode.InputBoxValidationSeverity.Warning }
        : undefined;
    },
  });
  return token?.trim() || undefined;
}
