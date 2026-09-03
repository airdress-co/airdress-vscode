import * as vscode from "vscode";
import { ProfileStore } from "../profiles/store";

/**
 * Tree: profiles -> kinds -> resources -> status.
 *
 * Construction and registration make no network calls; live data is
 * fetched lazily on expansion, and only then.
 */
export class ResourceTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly profiles: ProfileStore) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      // TODO(SPEC-057 T6-08): kinds + resources + status levels beneath
      // each profile, fetched lazily via ApiClient.
      return this.profiles
        .list()
        .map(
          (p) =>
            new TreeNode(p.label, p.fqdn, vscode.TreeItemCollapsibleState.None),
        );
    }
    return [];
  }
}

class TreeNode extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    state: vscode.TreeItemCollapsibleState,
  ) {
    super(label, state);
    this.description = description;
  }
}
