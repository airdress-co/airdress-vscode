import * as vscode from "vscode";
import { ApiError } from "../api/client";
import type { Profile } from "../profiles/model";
import type { ManifestDeps } from "../manifests/diff";
import { clientFor } from "../manifests/diff";
import type { TreeNodeData } from "../tree/nodes";
import { metadataLines, toAdminMetadata } from "./metadata";

/**
 * Principal administration — create, revoke, metadata, OIDC bind.
 *
 * Owner-only by construction: every entry point lives in the
 * Principals view, which is absent for non-owners. A 403 here is
 * therefore a STATE BUG (the view was visible when it should not have
 * been), and is reported as one, with a refresh.
 *
 * Credential discipline for create: the returned token is shown ONCE,
 * with explicit cannot-be-recovered wording. It is never written to
 * SecretStorage, to any file, to any log or output channel, and never
 * copied to the clipboard automatically — a credential the user did
 * not knowingly store is one they will not knowingly rotate. Copying
 * or storing it as a profile are separate, deliberate user actions.
 */

/** UI seam, injectable for tests. */
export interface PrincipalAdminUI {
  promptDisplayName(): Promise<string | undefined>;
  confirmCreate(name: string, profile: Profile): Promise<boolean>;
  /** One-shot reveal. The token exists only in this dialog's lifetime. */
  revealToken(
    name: string,
    token: string,
  ): Promise<"copy" | "add-profile" | "done">;
  /** Type-to-confirm: resolves the TYPED text, or undefined on cancel. */
  promptRevokeName(name: string, profile: Profile): Promise<string | undefined>;
  offerRunbook(url: string): Promise<void>;
  promptOidcSub(issuer: string, name: string): Promise<string | undefined>;
  info(message: string): void;
  error(message: string): void;
}

/** The revocation gate: only the sub-user's exact name passes. */
export function revocationGate(typed: string, name: string): boolean {
  return typed === name;
}

/** Runbook URLs come from settings so operators can redirect them. */
export function runbookUrl(kind: "revocation" | "ownerRecovery"): string {
  const cfg = vscode.workspace.getConfiguration("airdress.docs");
  return kind === "revocation"
    ? cfg.get<string>(
        "subUserRevocationRunbook",
        "https://docs.airdress.co/operator/sub-user-revocation",
      )
    : cfg.get<string>(
        "ownerTokenRecoveryRunbook",
        "https://docs.airdress.co/operator/owner-token-recovery",
      );
}

function describeStateBug(err: unknown, profile: Profile): string | undefined {
  if (err instanceof ApiError && err.httpStatus === 403) {
    // The Principals view should not have been visible for a
    // non-owner; reaching a 403 from it is a state bug, not a user
    // error. Say so and let the refresh hide the view again.
    return (
      `Airdress: ${profile.fqdn} says this profile is not an owner — ` +
      "the Principals view should not have been visible. Refreshing."
    );
  }
  return undefined;
}

export const defaultAdminUI: PrincipalAdminUI = {
  async promptDisplayName() {
    return vscode.window.showInputBox({
      title: "Airdress: New Sub-User",
      prompt: "Display name for the new sub-user.",
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length === 0 ? "Name must not be empty." : undefined,
    });
  },
  async confirmCreate(name, profile) {
    const choice = await vscode.window.showWarningMessage(
      `Create sub-user '${name}' on profile "${profile.label}" (${profile.fqdn})?`,
      { modal: true },
      "Create",
    );
    return choice === "Create";
  },
  async revealToken(name, token) {
    const choice = await vscode.window.showInformationMessage(
      `Sub-user '${name}' created.`,
      {
        modal: true,
        detail:
          `${token}\n\n` +
          "This token is shown once and cannot be recovered. " +
          "It is NOT stored by this extension. Copying it, or adding it " +
          "as a profile, is your action to take now.",
      },
      "Copy token",
      "Add as profile",
    );
    if (choice === "Copy token") {
      return "copy";
    }
    if (choice === "Add as profile") {
      return "add-profile";
    }
    return "done";
  },
  async promptRevokeName(name, profile) {
    return vscode.window.showInputBox({
      title: `Airdress: Revoke sub-user '${name}' on ${profile.fqdn}`,
      prompt:
        "This cannot be undone: the sub-user's derived keys are " +
        "destroyed. Offboarding has steps outside the operator — the " +
        "sub-user revocation runbook covers them. Type the sub-user's " +
        "name to confirm.",
      ignoreFocusOut: true,
      validateInput: (v) =>
        revocationGate(v, name)
          ? undefined
          : `Type '${name}' exactly to confirm revocation.`,
    });
  },
  async offerRunbook(url) {
    const choice = await vscode.window.showInformationMessage(
      "Offboarding has steps outside the operator.",
      "Open the revocation runbook",
    );
    if (choice) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  },
  async promptOidcSub(issuer, name) {
    return vscode.window.showInputBox({
      title: `Airdress: Attach an Identity to '${name}'`,
      prompt:
        `Issuer (from this profile's auth configuration): ${issuer} — ` +
        "enter the subject (sub) of the identity to attach. Binding is " +
        "idempotent: repeating it with the same identity is a no-op.",
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length === 0 ? "Subject must not be empty." : undefined,
    });
  },
  info(message) {
    void vscode.window.showInformationMessage(message);
  },
  error(message) {
    void vscode.window.showErrorMessage(message);
  },
};

export interface PrincipalAdminDeps {
  manifest: ManifestDeps;
  ui: PrincipalAdminUI;
  /** Separate, deliberate action: store the token as a new profile. */
  addBearerProfile(
    profile: Profile,
    displayName: string,
    token: string,
  ): Promise<void>;
  copyToClipboard(token: string): Promise<void>;
  refreshPrincipals(): void;
}

/** Create a sub-user with a one-shot credential reveal. */
export async function createSubUser(
  deps: PrincipalAdminDeps,
  profile: Profile,
): Promise<void> {
  const name = (await deps.ui.promptDisplayName())?.trim();
  if (!name) {
    return;
  }
  if (!(await deps.ui.confirmCreate(name, profile))) {
    return;
  }
  let created: { id: string; token: string };
  try {
    const response = await clientFor(deps.manifest, profile).request<
      Record<string, unknown>
    >("/v1/admin/sub-users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: name }),
    });
    const id = typeof response.id === "string" ? response.id : "";
    const token = typeof response.token === "string" ? response.token : "";
    if (!token) {
      deps.ui.error(
        `Airdress: ${profile.fqdn} created '${name}' but returned no token — check the operator's logs from the host.`,
      );
      deps.refreshPrincipals();
      return;
    }
    created = { id, token };
  } catch (err) {
    const stateBug = describeStateBug(err, profile);
    deps.ui.error(
      stateBug ??
        `Airdress: creating sub-user '${name}' on ${profile.fqdn} failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    deps.refreshPrincipals();
    return;
  }

  // One-shot reveal. The token variable's scope ENDS with this block:
  // no store, no log, no output channel, no automatic clipboard.
  const action = await deps.ui.revealToken(name, created.token);
  if (action === "copy") {
    await deps.copyToClipboard(created.token);
    deps.ui.info(
      "Airdress: token copied. It cannot be shown again — store it now.",
    );
  } else if (action === "add-profile") {
    await deps.addBearerProfile(profile, name, created.token);
    deps.ui.info(
      `Airdress: profile '${name} @ ${profile.fqdn}' added with the new token.`,
    );
  }
  deps.refreshPrincipals();
}

/** Revoke a sub-user behind a type-the-name confirmation. */
export async function revokeSubUser(
  deps: PrincipalAdminDeps,
  node: TreeNodeData,
): Promise<void> {
  if (node?.type !== "principal") {
    return;
  }
  const { profile, principal } = node;
  const typed = await deps.ui.promptRevokeName(principal.displayName, profile);
  if (typed === undefined) {
    return;
  }
  if (!revocationGate(typed, principal.displayName)) {
    // The input box validates interactively; this is the last line of
    // defence for programmatic paths. No OK-only path exists.
    return;
  }
  try {
    await clientFor(deps.manifest, profile).request<undefined>(
      `/v1/admin/sub-users/${encodeURIComponent(principal.id)}`,
      { method: "DELETE" },
    );
    deps.ui.info(
      `Airdress: sub-user '${principal.displayName}' revoked on ${profile.fqdn}.`,
    );
    await deps.ui.offerRunbook(runbookUrl("revocation"));
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404) {
      // Do not retry a delete that already happened.
      deps.ui.info(
        `Airdress: '${principal.displayName}' was already revoked or never existed on ${profile.fqdn}.`,
      );
    } else {
      const stateBug = describeStateBug(err, profile);
      deps.ui.error(
        stateBug ??
          `Airdress: revoking '${principal.displayName}' on ${profile.fqdn} failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
  }
  deps.refreshPrincipals();
}

/**
 * Show a principal's admin metadata, read-only, via the airdress:
 * virtual document scheme (no filesystem write path exists for it).
 */
export async function showPrincipalMetadata(
  deps: PrincipalAdminDeps,
  node: TreeNodeData,
  openDocument: (content: string, principalId: string) => Promise<void>,
): Promise<void> {
  if (node?.type !== "principal") {
    return;
  }
  const { profile, principal } = node;
  try {
    const wire = await clientFor(deps.manifest, profile).request<
      Record<string, unknown>
    >(`/v1/admin/sub-users/${encodeURIComponent(principal.id)}/metadata`);
    const meta = toAdminMetadata(wire);
    await openDocument(metadataLines(meta).join("\n") + "\n", principal.id);
  } catch (err) {
    const stateBug = describeStateBug(err, profile);
    deps.ui.error(
      stateBug ??
        `Airdress: fetching metadata for '${principal.displayName}' failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}

/**
 * Attach an OIDC identity to a principal. The issuer is pre-filled
 * from the profile's own auth configuration — never hand-typed — and
 * the endpoint is idempotent on (issuer, sub), so a repeat is a no-op
 * reported as success, not an error.
 */
export async function bindOidcIdentity(
  deps: PrincipalAdminDeps,
  node: TreeNodeData,
  issuer: string,
): Promise<void> {
  if (node?.type !== "principal") {
    return;
  }
  const { profile, principal } = node;
  const sub = (
    await deps.ui.promptOidcSub(issuer, principal.displayName)
  )?.trim();
  if (!sub) {
    return;
  }
  try {
    await clientFor(deps.manifest, profile).send("/v1/admin/principals/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principal_id: principal.id,
        oidc_issuer: issuer,
        oidc_sub: sub,
      }),
    });
    deps.ui.info(
      `Airdress: '${principal.displayName}' is bound to ${sub} at ${issuer}.`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 409) {
      // Idempotent bind: already bound to this identity is SUCCESS.
      deps.ui.info(
        `Airdress: '${principal.displayName}' is bound to ${sub} at ${issuer}.`,
      );
    } else {
      const stateBug = describeStateBug(err, profile);
      deps.ui.error(
        stateBug ??
          `Airdress: binding '${principal.displayName}' failed — ${
            err instanceof Error ? err.message : String(err)
          } (retrying is safe: the bind is idempotent)`,
      );
    }
  }
  deps.refreshPrincipals();
}
