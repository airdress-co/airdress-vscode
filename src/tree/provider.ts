import * as vscode from "vscode";
import { ProfileStore } from "../profiles/store";
import { bundledSchemas } from "../manifests/schemas";
import type {
  EnrollmentMeta,
  PrincipalMeta,
  ResourceRef,
  TreeFetchers,
  TreeNodeData,
} from "./nodes";

/**
 * Read-only resource tree (SPEC-057 T6-06, design §6):
 * profiles → kinds → resources; principals (owner-only, metadata-only);
 * enrollments.
 *
 * - Construction and registration make no network calls; live data is
 *   fetched lazily on expansion, and only then.
 * - The Principals branch is ABSENT for non-owners, never
 *   present-and-403.
 * - No create/revoke action is contributed on principals — that is
 *   SPEC-058 scope (no contextValue enables such a menu).
 * - Opening a resource opens the read-only airdress: virtual document
 *   (the same one T6-04's diff uses as its left side); nothing is
 *   written to disk.
 * - An unreachable operator puts an error node under the profile; the
 *   profile itself stays selected (design §9).
 */
export class ResourceTreeProvider implements vscode.TreeDataProvider<TreeNodeData> {
  private readonly emitter = new vscode.EventEmitter<
    TreeNodeData | undefined
  >();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly knownKinds = new Set(bundledSchemas().map((s) => s.kind));

  constructor(
    private readonly profiles: ProfileStore,
    private readonly fetchers?: TreeFetchers,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNodeData): vscode.TreeItem {
    switch (node.type) {
      case "profile": {
        const item = new vscode.TreeItem(
          node.profile.label,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description =
          node.profile.fqdn + (node.profile.dev ? " (dev)" : "");
        item.iconPath = new vscode.ThemeIcon("radio-tower");
        item.contextValue = "airdressProfile";
        return item;
      }
      case "section": {
        const labels = {
          kinds: "Kinds",
          principals: "Principals",
          enrollments: "Enrollments",
        } as const;
        const item = new vscode.TreeItem(
          labels[node.section],
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = `airdressSection.${node.section}`;
        return item;
      }
      case "kind": {
        const item = new vscode.TreeItem(
          node.kind,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        if (!node.known) {
          // NFR-10: honesty over green checkmarks.
          item.description = "unknown, validation disabled";
          item.iconPath = new vscode.ThemeIcon("question");
        }
        return item;
      }
      case "resource": {
        const item = new vscode.TreeItem(
          node.resource.name,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon("symbol-object");
        item.contextValue = "airdressResource";
        item.command = {
          command: "airdress.resources.open",
          title: "Open Live Manifest (read-only)",
          arguments: [node],
        };
        return item;
      }
      case "principal": {
        // Metadata ONLY (SPEC-042). Leaf node: no children, no lazy
        // loader, no content field to populate — and read-only: no
        // create/revoke contextValue exists for menus to hang off.
        const item = new vscode.TreeItem(
          node.principal.displayName,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.principal.revokedAt
          ? "revoked — metadata only"
          : "metadata only";
        item.iconPath = new vscode.ThemeIcon("person");
        item.tooltip = [
          `id: ${node.principal.id}`,
          `created: ${node.principal.createdAt}`,
          node.principal.lastUsedAt
            ? `last used: ${node.principal.lastUsedAt}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        return item;
      }
      case "enrollment": {
        const item = new vscode.TreeItem(
          node.enrollment.id,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.enrollment.createdAt;
        item.iconPath = new vscode.ThemeIcon("device-mobile");
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(
          node.text,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon("warning");
        return item;
      }
    }
  }

  async getChildren(node?: TreeNodeData): Promise<TreeNodeData[]> {
    if (!node) {
      return this.profiles
        .list()
        .map((profile) => ({ type: "profile", profile }));
    }
    if (!this.fetchers) {
      return [];
    }
    try {
      switch (node.type) {
        case "profile": {
          const children: TreeNodeData[] = [
            { type: "section", profile: node.profile, section: "kinds" },
          ];
          // Owner-only branch: ABSENT for non-owners (design §6). The
          // probe happens here, at expansion time — never at activation.
          const principals = await this.fetchers.listPrincipals(node.profile);
          if (principals !== "forbidden") {
            children.push({
              type: "section",
              profile: node.profile,
              section: "principals",
            });
          }
          children.push({
            type: "section",
            profile: node.profile,
            section: "enrollments",
          });
          return children;
        }
        case "section":
          switch (node.section) {
            case "kinds": {
              const kinds = await this.fetchers.listKinds(node.profile);
              return kinds.map((kind) => ({
                type: "kind",
                profile: node.profile,
                kind,
                known: this.knownKinds.has(kind),
              }));
            }
            case "principals": {
              const principals = await this.fetchers.listPrincipals(
                node.profile,
              );
              if (principals === "forbidden") {
                return [];
              }
              return principals.map((principal) => ({
                type: "principal",
                profile: node.profile,
                principal,
              }));
            }
            case "enrollments": {
              const enrollments = await this.fetchers.listEnrollments(
                node.profile,
              );
              return enrollments.map((enrollment) => ({
                type: "enrollment",
                profile: node.profile,
                enrollment,
              }));
            }
          }
          break;
        case "kind": {
          const resources = await this.fetchers.listResources(
            node.profile,
            node.kind,
          );
          return resources.map((resource) => ({
            type: "resource",
            profile: node.profile,
            resource,
          }));
        }
        default:
          return [];
      }
    } catch (err) {
      // Unreachable operator: an error node, and the profile STAYS —
      // never a silent profile switch (design §9).
      return [
        {
          type: "message",
          text: err instanceof Error ? err.message : String(err),
        },
      ];
    }
    return [];
  }
}

export type { EnrollmentMeta, PrincipalMeta, ResourceRef, TreeFetchers };
