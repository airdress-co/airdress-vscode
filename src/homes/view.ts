import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import type { ProfileStore } from "../profiles/store";
import {
  describeHomesError,
  homeDescription,
  homeDetailRows,
  isConnected,
  listHomes,
  type HomeSummary,
} from "./model";

/**
 * The Homes view: every `Home` on the ACTIVE profile, read-only. Hidden
 * for anybody but the owner, by the same context key as Pending Machines.
 * An operator without the Kind shows the welcome text, not an error.
 */

export type HomeNode =
  | { type: "home"; profile: Profile; home: HomeSummary }
  | { type: "homeDetail"; label: string; value: string; icon: string }
  | { type: "homeMessage"; text: string; icon: string };

export class HomesTreeProvider implements vscode.TreeDataProvider<HomeNode> {
  private readonly emitter = new vscode.EventEmitter<HomeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(
    private readonly profiles: ProfileStore,
    private readonly client: (profile: Profile) => ApiClient,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  private activeProfile(): Profile | undefined {
    const id = this.profiles.activeId();
    return id ? this.profiles.get(id) : undefined;
  }

  async getChildren(node?: HomeNode): Promise<HomeNode[]> {
    if (node) {
      return node.type === "home"
        ? homeDetailRows(node.home).map((r) => ({ type: "homeDetail", ...r }))
        : [];
    }
    const profile = this.activeProfile();
    if (!profile) {
      return [];
    }
    try {
      const homes = await listHomes(this.client(profile));
      return homes.map((home) => ({ type: "home", profile, home }));
    } catch (err) {
      return [
        { type: "homeMessage", text: describeHomesError(err), icon: "warning" },
      ];
    }
  }

  getTreeItem(node: HomeNode): vscode.TreeItem {
    switch (node.type) {
      case "home": {
        const h = node.home;
        const item = new vscode.TreeItem(
          h.name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = homeDescription(h);
        item.iconPath = new vscode.ThemeIcon(
          isConnected(h) ? "home" : "debug-disconnect",
        );
        item.contextValue = "airdressHome";
        item.tooltip = homeDetailRows(h)
          .map((r) => `${r.label}: ${r.value}`)
          .join("\n");
        return item;
      }
      case "homeDetail": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.value;
        item.tooltip = `${node.label}: ${node.value}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case "homeMessage": {
        const item = new vscode.TreeItem(
          node.text,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }
}
