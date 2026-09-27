import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import {
  approveEnrollment,
  comparedValue,
  DEFAULT_HOME_NAME,
  denyEnrollment,
  describeMachineError,
  isExpired,
  linkNameProblem,
  offersHomeLink,
  type MachineLink,
  type PendingEnrollment,
} from "./pending";

/**
 * Approve and deny a pending machine.
 *
 * Approval has one shape and no shortcut: the owner is shown what the
 * operator holds (the confirmation code, or the fingerprint when the
 * operator has no code), says whether the machine shows the same, and
 * only a "matches" answer sends anything. A "does not match" answer
 * offers Deny instead. The Home link is asked about only when the
 * operator advertised it for this enrollment.
 */

/** The owner's answer to the comparison. */
export type Comparison = "matches" | "differs" | undefined;

/** Whether to also link, and as what. `undefined` means cancelled. */
export type LinkChoice = { link?: MachineLink } | undefined;

/** UI seam, injectable for tests. */
export interface PendingMachineUI {
  compare(e: PendingEnrollment, profile: Profile): Promise<Comparison>;
  /** Asked only when the enrollment offers a Home link. */
  chooseHomeLink(e: PendingEnrollment): Promise<LinkChoice>;
  confirmDeny(e: PendingEnrollment, profile: Profile): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
}

export interface PendingMachineDeps {
  client(profile: Profile): ApiClient;
  ui: PendingMachineUI;
  refresh(): void;
}

/** `WDJB-MJHT`, however the operator spelled it. */
function formatCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : code;
}

/** The comparison prompt's title, naming the value to check. */
export function comparisonTitle(e: PendingEnrollment): string {
  const { field, value } = comparedValue(e);
  return field === "confirmation_code"
    ? `Does '${e.name}' show the confirmation code ${formatCode(value)}?`
    : `Does '${e.name}' show the fingerprint ${value}?`;
}

export const defaultPendingMachineUI: PendingMachineUI = {
  async compare(e, profile) {
    const { field } = comparedValue(e);
    const what = field === "confirmation_code" ? "code" : "fingerprint";
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: `$(check) The machine shows this ${what}`,
          description: "approve it",
          answer: "matches" as const,
        },
        {
          label: `$(x) It shows something else`,
          description: "do not approve",
          answer: "differs" as const,
        },
      ],
      {
        title: comparisonTitle(e),
        placeHolder:
          `Read it on the machine itself, not from a message about it. ` +
          `Approving admits '${e.name}' to ${profile.fqdn}.`,
        ignoreFocusOut: true,
      },
    );
    return picked?.answer;
  },
  async chooseHomeLink(e) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "Approve only",
          link: false,
        },
        {
          label: "Approve and also link as Home",
          description: e.purpose ? `for ${e.purpose}` : undefined,
          link: true,
        },
      ],
      {
        title: `Also link '${e.name}' as Home?`,
        ignoreFocusOut: true,
      },
    );
    if (!picked) {
      return undefined;
    }
    if (!picked.link) {
      return {};
    }
    const name = await vscode.window.showInputBox({
      title: `Name for the Home link of '${e.name}'`,
      value: DEFAULT_HOME_NAME,
      prompt: "The Home resource this machine is linked as.",
      ignoreFocusOut: true,
      validateInput: (v) => linkNameProblem(v),
    });
    return name === undefined ? undefined : { link: { kind: "Home", name } };
  },
  async confirmDeny(e, profile) {
    const choice = await vscode.window.showWarningMessage(
      `Deny '${e.name}' on ${profile.fqdn}?`,
      {
        modal: true,
        detail:
          `User code ${formatCode(e.userCode)}. ` +
          "The machine is told it was refused and has to start again to ask a second time.",
      },
      "Deny",
    );
    return choice === "Deny";
  },
  info(message) {
    void vscode.window.showInformationMessage(message);
  },
  error(message) {
    void vscode.window.showErrorMessage(message);
  },
};

/**
 * Approve: compare, optionally link, send. Returns what happened, for
 * tests and for callers that chain.
 */
export async function approvePendingMachine(
  deps: PendingMachineDeps,
  profile: Profile,
  e: PendingEnrollment,
): Promise<"approved" | "denied" | "cancelled" | "failed"> {
  if (isExpired(e)) {
    deps.ui.error(
      `Airdress: the enrollment for '${e.name}' has expired. Start it again on the machine.`,
    );
    deps.refresh();
    return "failed";
  }
  const answer = await deps.ui.compare(e, profile);
  if (answer === undefined) {
    return "cancelled";
  }
  if (answer === "differs") {
    // Not approving is already the safe outcome; denying is offered
    // because a mismatch means somebody else's key is waiting.
    deps.ui.error(
      `Airdress: '${e.name}' was not approved — what the machine shows differs from what ${profile.fqdn} holds.`,
    );
    return (await denyPendingMachine(deps, profile, e)) === "denied"
      ? "denied"
      : "cancelled";
  }
  let link: MachineLink | undefined;
  if (offersHomeLink(e)) {
    const choice = await deps.ui.chooseHomeLink(e);
    if (choice === undefined) {
      return "cancelled";
    }
    link = choice.link;
  }
  try {
    const result = await approveEnrollment(deps.client(profile), e, link);
    const linked = result.link
      ? ` and linked as Home '${result.link.name}'`
      : "";
    deps.ui.info(
      `Airdress: '${result.name ?? e.name}' approved on ${profile.fqdn}${linked}` +
        (result.machineId ? ` (machine ${result.machineId}).` : "."),
    );
    deps.refresh();
    return "approved";
  } catch (err) {
    deps.ui.error(`Airdress: ${describeMachineError(err, e.name)}`);
    deps.refresh();
    return "failed";
  }
}

/** Deny, behind a modal confirmation. */
export async function denyPendingMachine(
  deps: PendingMachineDeps,
  profile: Profile,
  e: PendingEnrollment,
): Promise<"denied" | "cancelled" | "failed"> {
  if (!(await deps.ui.confirmDeny(e, profile))) {
    return "cancelled";
  }
  try {
    await denyEnrollment(deps.client(profile), e);
    deps.ui.info(`Airdress: '${e.name}' denied on ${profile.fqdn}.`);
    deps.refresh();
    return "denied";
  } catch (err) {
    deps.ui.error(`Airdress: ${describeMachineError(err, e.name)}`);
    deps.refresh();
    return "failed";
  }
}
