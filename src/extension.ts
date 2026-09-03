import * as vscode from "vscode";
import { ResourceTreeProvider } from "./tree/provider";
import { ProfileStore } from "./profiles/store";
import { pickProfile } from "./profiles/picker";

/**
 * Extension entry point.
 *
 * Registers providers and commands only — no network calls happen here.
 * All operator API traffic is deferred until a user gesture (a command,
 * a tree expansion) explicitly asks for it.
 */
export function activate(context: vscode.ExtensionContext): void {
  const profiles = new ProfileStore(context.globalState);
  const tree = new ResourceTreeProvider(profiles);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("airdress.resources", tree),

    vscode.commands.registerCommand("airdress.profiles.add", async () => {
      // TODO(SPEC-057 T6-01): profile creation flow (FQDN validation per FR-25).
      void vscode.window.showInformationMessage(
        "Airdress: profile creation is not implemented yet.",
      );
    }),

    vscode.commands.registerCommand("airdress.profiles.pick", async () => {
      await pickProfile(profiles);
    }),

    vscode.commands.registerCommand("airdress.profiles.signOut", async () => {
      // TODO(SPEC-057 T6-02): clear SecretStorage entries for the active profile.
      void vscode.window.showInformationMessage(
        "Airdress: sign-out is not implemented yet.",
      );
    }),

    vscode.commands.registerCommand("airdress.resources.refresh", () => {
      tree.refresh();
    }),

    vscode.commands.registerCommand("airdress.manifests.diff", async () => {
      // TODO(SPEC-057 T6-05): fetch live manifest -> virtual doc -> vscode.diff.
      void vscode.window.showInformationMessage(
        "Airdress: manifest diff is not implemented yet.",
      );
    }),
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond context.subscriptions.
}
