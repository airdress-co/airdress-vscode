import * as vscode from "vscode";
import { ApiError } from "../api/client";
import type { Profile } from "../profiles/model";
import { revokeEnrollmentConfirm } from "../profiles/confirm";
import type { ManifestDeps } from "../manifests/diff";
import { clientFor } from "../manifests/diff";
import type { EnrollmentMeta, TreeNodeData } from "../tree/nodes";

/**
 * Revoke one device's enrollment from the Enrollments node.
 *
 * For a device that can no longer act for itself — a lost, wiped or
 * dead phone. A device may revoke within its own scope; the owner's
 * OIDC sign-in may revoke any enrollment on the operator (operator
 * PR #218). Whether this profile may is the operator's decision, so
 * the action is offered on every row and a refusal is reported as one
 * rather than predicted here.
 *
 * `DELETE /v1/endpoints/enrollments/{id}` behind a modal confirmation
 * that names the device and the target profile; the Resources view is
 * refreshed afterwards whatever the outcome, so a revoked row drops out
 * and a stale one does not linger.
 */

/** UI seam, injectable for tests. */
export interface EnrollmentRevokeUI {
  confirmRevoke(enrollment: EnrollmentMeta, profile: Profile): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
}

export interface EnrollmentRevokeDeps {
  manifest: ManifestDeps;
  ui: EnrollmentRevokeUI;
  refreshResources(): void;
}

export const defaultEnrollmentRevokeUI: EnrollmentRevokeUI = {
  async confirmRevoke(enrollment, profile) {
    const choice = await vscode.window.showWarningMessage(
      revokeEnrollmentConfirm(enrollment, profile),
      {
        modal: true,
        detail:
          (enrollment.airdress ? `Airdress: ${enrollment.airdress}\n\n` : "") +
          "The device's session stops working on its next request. " +
          "It cannot be undone; the device has to be paired again.",
      },
      "Revoke",
    );
    return choice === "Revoke";
  },
  info(message) {
    void vscode.window.showInformationMessage(message);
  },
  error(message) {
    void vscode.window.showErrorMessage(message);
  },
};

function name(enrollment: EnrollmentMeta): string {
  return enrollment.deviceLabel
    ? `'${enrollment.deviceLabel}' (${enrollment.id})`
    : enrollment.id;
}

export async function revokeEnrollment(
  deps: EnrollmentRevokeDeps,
  node: TreeNodeData,
): Promise<void> {
  if (node?.type !== "enrollment") {
    return;
  }
  const { profile, enrollment } = node;
  if (!(await deps.ui.confirmRevoke(enrollment, profile))) {
    return;
  }
  try {
    await clientFor(deps.manifest, profile).request<undefined>(
      `/v1/endpoints/enrollments/${encodeURIComponent(enrollment.id)}`,
      { method: "DELETE" },
    );
    deps.ui.info(
      `Airdress: enrollment ${name(enrollment)} revoked on ${profile.fqdn}.`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404) {
      // Do not retry a delete that already happened.
      deps.ui.info(
        `Airdress: enrollment ${name(enrollment)} was already revoked or never existed on ${profile.fqdn}.`,
      );
    } else if (err instanceof ApiError && err.httpStatus === 403) {
      deps.ui.error(
        `Airdress: ${profile.fqdn} refused to revoke ${name(enrollment)} for this sign-in. ` +
          "A device may only revoke within its own scope; revoking any device needs the " +
          "owner's sign-in on an operator that accepts it.",
      );
    } else {
      deps.ui.error(
        `Airdress: revoking ${name(enrollment)} on ${profile.fqdn} failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  deps.refreshResources();
}
