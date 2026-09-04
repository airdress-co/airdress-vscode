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
 * Three sidebar views, one per concern (one view per concern is what
 * keeps a destructive action a place you GO, not a branch you hit
 * while expanding something else):
 *
 *   Operators   — every profile: active marker, sign-in state.
 *   Resources   — kinds → resources (+ enrollments), ACTIVE profile only.
 *   Principals  — sub-users of the active profile, owner-only. The view
 *                 itself is hidden (context key) for non-owners: absent,
 *                 never present-and-403.
 *
 * Shared rules, unchanged from the single-tree era:
 * - Construction and registration make no network calls; live data is
 *   fetched lazily on expansion or when a view becomes visible.
 * - Principal rows are admin metadata ONLY (sub-user isolation
 *   boundary) — no child nodes, no field that could hold content.
 * - An unreachable operator renders an error node; nothing is silently
 *   dropped or switched.
 */

abstract class BaseTreeProvider implements vscode.TreeDataProvider<TreeNodeData> {
  protected readonly emitter = new vscode.EventEmitter<
    TreeNodeData | undefined
  >();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly knownKinds = new Set(bundledSchemas().map((s) => s.kind));

  refresh(): void {
    this.emitter.fire(undefined);
  }

  abstract getChildren(node?: TreeNodeData): Promise<TreeNodeData[]>;

  getTreeItem(node: TreeNodeData): vscode.TreeItem {
    switch (node.type) {
      case "profile": {
        const item = new vscode.TreeItem(
          node.profile.label,
          vscode.TreeItemCollapsibleState.None,
        );
        const flags = [
          node.profile.dev ? "dev" : undefined,
          node.active ? "active" : undefined,
          node.signedIn === false ? "no credential" : undefined,
        ].filter(Boolean);
        item.description =
          node.profile.fqdn + (flags.length ? ` (${flags.join(", ")})` : "");
        item.iconPath = new vscode.ThemeIcon(
          node.active ? "circle-filled" : "radio-tower",
        );
        item.contextValue = "airdressProfile";
        item.tooltip = [
          node.profile.fqdn,
          node.active ? "Active profile" : "Click to make active",
          node.signedIn === false
            ? "No credential stored — sign in first"
            : node.signedIn
              ? "Signed in"
              : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        item.command = {
          command: "airdress.profiles.activate",
          title: "Set Active Profile",
          arguments: [node],
        };
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
          // Honesty over green checkmarks.
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
        // Metadata ONLY (sub-user isolation boundary). Leaf node: no
        // children, no lazy loader, no content field to populate.
        const item = new vscode.TreeItem(
          node.principal.displayName,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.principal.revokedAt
          ? "revoked — metadata only"
          : "metadata only";
        item.iconPath = new vscode.ThemeIcon("person");
        item.contextValue = "airdressPrincipal";
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

  protected isKnownKind(kind: string): boolean {
    return this.knownKinds.has(kind);
  }

  protected errorNode(err: unknown): TreeNodeData[] {
    return [
      {
        type: "message",
        text: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

/** The Operators view: every profile, flat. Clicking activates. */
export class OperatorsTreeProvider extends BaseTreeProvider {
  constructor(
    private readonly profiles: ProfileStore,
    /** SecretStorage lookup — local, never a network call. */
    private readonly hasCredential?: (
      profile: TreeNodeData & { type: "profile" },
    ) => Promise<boolean>,
  ) {
    super();
  }

  async getChildren(node?: TreeNodeData): Promise<TreeNodeData[]> {
    if (node) {
      return [];
    }
    const activeId = this.profiles.activeId();
    return Promise.all(
      this.profiles.list().map(async (profile) => {
        const base: TreeNodeData & { type: "profile" } = {
          type: "profile",
          profile,
          active: profile.id === activeId,
        };
        if (!this.hasCredential) {
          return base;
        }
        try {
          return { ...base, signedIn: await this.hasCredential(base) };
        } catch {
          return base;
        }
      }),
    );
  }
}

/**
 * The Resources view: kinds → resources, scoped to the ACTIVE profile
 * (plus the enrollments listing, kept from the single-tree era so no
 * capability is lost in the split).
 */
export class ResourcesTreeProvider extends BaseTreeProvider {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly fetchers?: TreeFetchers,
  ) {
    super();
  }

  private activeProfile() {
    const id = this.profiles.activeId();
    return id ? this.profiles.get(id) : undefined;
  }

  async getChildren(node?: TreeNodeData): Promise<TreeNodeData[]> {
    const profile = this.activeProfile();
    if (!profile) {
      return node
        ? []
        : [
            {
              type: "message",
              text: "No active profile — pick one in the Operators view.",
            },
          ];
    }
    if (!this.fetchers) {
      return [];
    }
    try {
      if (!node) {
        const kinds = await this.fetchers.listKinds(profile);
        const roots: TreeNodeData[] = kinds.map((kind) => ({
          type: "kind",
          profile,
          kind,
          known: this.isKnownKind(kind),
        }));
        roots.push({ type: "section", profile, section: "enrollments" });
        return roots;
      }
      switch (node.type) {
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
        case "section": {
          if (node.section !== "enrollments") {
            return [];
          }
          const enrollments = await this.fetchers.listEnrollments(node.profile);
          return enrollments.map((enrollment) => ({
            type: "enrollment",
            profile: node.profile,
            enrollment,
          }));
        }
        default:
          return [];
      }
    } catch (err) {
      return this.errorNode(err);
    }
  }
}

/**
 * The Principals view: sub-users of the active profile, flat, metadata
 * only. For a non-owner the containing VIEW is hidden via the
 * `airdress.principalsAvailable` context key — this provider returning
 * [] for "forbidden" is defence in depth, not the primary gate.
 */
export class PrincipalsTreeProvider extends BaseTreeProvider {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly fetchers?: TreeFetchers,
  ) {
    super();
  }

  async getChildren(node?: TreeNodeData): Promise<TreeNodeData[]> {
    if (node) {
      return [];
    }
    const id = this.profiles.activeId();
    const profile = id ? this.profiles.get(id) : undefined;
    if (!profile || !this.fetchers) {
      return [];
    }
    try {
      const principals = await this.fetchers.listPrincipals(profile);
      if (principals === "forbidden") {
        return [];
      }
      return principals.map((principal) => ({
        type: "principal",
        profile,
        principal,
      }));
    } catch (err) {
      return this.errorNode(err);
    }
  }
}

export type { EnrollmentMeta, PrincipalMeta, ResourceRef, TreeFetchers };
