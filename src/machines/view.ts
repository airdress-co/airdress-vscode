import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import type { ProfileStore } from "../profiles/store";
import {
  describeListingError,
  isExpired,
  listPendingEnrollments,
  offersHomeLink,
  type PendingEnrollment,
} from "./pending";

/**
 * The Pending Machines view: enrollments on the ACTIVE profile waiting
 * for the owner. Owner-only, like Principals — the view is hidden by the
 * same context key for anybody else. Fetched lazily, when the view asks.
 *
 * Each enrollment expands into the facts the owner compares and decides
 * on, one per row, so none is hidden in a tooltip.
 */

export type PendingMachineNode =
  | { type: "pendingMachine"; profile: Profile; enrollment: PendingEnrollment }
  | { type: "pendingDetail"; label: string; value: string; icon: string }
  | { type: "pendingMessage"; text: string; icon: string };

/** The detail rows for one enrollment, in the order they are read. */
export function detailRows(
  e: PendingEnrollment,
  now: Date = new Date(),
): { label: string; value: string; icon: string }[] {
  const rows = [
    e.confirmationCode
      ? {
          label: "Confirmation code",
          value: e.confirmationCode,
          icon: "shield",
        }
      : undefined,
    { label: "Fingerprint", value: e.fingerprint, icon: "key" },
    { label: "User code", value: e.userCode, icon: "symbol-key" },
    { label: "Purpose", value: e.purpose ?? "none stated", icon: "info" },
    e.kind === "reauth"
      ? {
          label: "Re-key of machine",
          value: e.machineId ?? "unknown",
          icon: "history",
        }
      : undefined,
    offersHomeLink(e)
      ? { label: "Can be linked as", value: "Home", icon: "home" }
      : undefined,
    e.expiresAt
      ? {
          label: isExpired(e, now) ? "Expired" : "Expires",
          value: e.expiresAt,
          icon: isExpired(e, now) ? "warning" : "clock",
        }
      : undefined,
  ];
  return rows.filter((r): r is NonNullable<typeof r> => r !== undefined);
}

export class PendingMachinesTreeProvider implements vscode.TreeDataProvider<PendingMachineNode> {
  private readonly emitter = new vscode.EventEmitter<
    PendingMachineNode | undefined
  >();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(
    private readonly profiles: ProfileStore,
    private readonly client: (profile: Profile) => ApiClient,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** The active profile, if any. */
  activeProfile(): Profile | undefined {
    const id = this.profiles.activeId();
    return id ? this.profiles.get(id) : undefined;
  }

  /** Fetch the listing for a profile, now. */
  async fetch(profile: Profile): Promise<PendingEnrollment[]> {
    return listPendingEnrollments(this.client(profile));
  }

  async getChildren(node?: PendingMachineNode): Promise<PendingMachineNode[]> {
    if (node) {
      return node.type === "pendingMachine"
        ? detailRows(node.enrollment).map((r) => ({
            type: "pendingDetail",
            ...r,
          }))
        : [];
    }
    const profile = this.activeProfile();
    if (!profile) {
      return [];
    }
    try {
      const enrollments = await this.fetch(profile);
      // An empty list renders the view's welcome text.
      return enrollments.map((enrollment) => ({
        type: "pendingMachine",
        profile,
        enrollment,
      }));
    } catch (err) {
      return [
        {
          type: "pendingMessage",
          text: describeListingError(err),
          icon: "warning",
        },
      ];
    }
  }

  getTreeItem(node: PendingMachineNode): vscode.TreeItem {
    switch (node.type) {
      case "pendingMachine": {
        const e = node.enrollment;
        const item = new vscode.TreeItem(
          e.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = [
          e.userCode,
          e.purpose,
          e.kind === "reauth" ? "re-key" : undefined,
          isExpired(e) ? "expired" : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        item.iconPath = new vscode.ThemeIcon(
          isExpired(e) ? "warning" : "server",
        );
        item.contextValue = "airdressPendingMachine";
        item.tooltip = detailRows(e)
          .map((r) => `${r.label}: ${r.value}`)
          .join("\n");
        return item;
      }
      case "pendingDetail": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.value;
        item.tooltip = `${node.label}: ${node.value}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case "pendingMessage": {
        const item = new vscode.TreeItem(
          node.text,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  /**
   * The enrollment a command acts on: the row it was run on, or — from
   * the palette — one picked from a fresh listing of the active profile.
   */
  async resolve(
    node: PendingMachineNode | undefined,
    pick: (
      enrollments: PendingEnrollment[],
    ) => Promise<PendingEnrollment | undefined>,
  ): Promise<
    { profile: Profile; enrollment: PendingEnrollment } | undefined | string
  > {
    if (node?.type === "pendingMachine") {
      return { profile: node.profile, enrollment: node.enrollment };
    }
    const profile = this.activeProfile();
    if (!profile) {
      return "no active airdress — pick one first.";
    }
    let enrollments: PendingEnrollment[];
    try {
      enrollments = await this.fetch(profile);
    } catch (err) {
      return describeListingError(err);
    }
    if (enrollments.length === 0) {
      return `no machines are waiting on ${profile.fqdn}.`;
    }
    const enrollment = await pick(enrollments);
    return enrollment ? { profile, enrollment } : undefined;
  }
}
