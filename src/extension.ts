import * as vscode from "vscode";
import { ResourceTreeProvider } from "./tree/provider";
import { ProfileStore } from "./profiles/store";
import { pickProfile } from "./profiles/picker";
import { CallbackRouter } from "./auth/zitadel";
import { SecretStore } from "./auth/store";
import { AuthManager } from "./auth/manager";

/**
 * Singleton auth-callback dispatcher. VS Code allows one UriHandler per
 * extension; sign-in flows await their pending state on this router.
 */
export const callbackRouter = new CallbackRouter();

/**
 * Extension entry point.
 *
 * Registers providers and commands only — no network calls happen here.
 * All operator API traffic is deferred until a user gesture (a command,
 * a tree expansion) explicitly asks for it.
 */
export function activate(context: vscode.ExtensionContext): void {
  const profiles = new ProfileStore(context.globalState);
  const auth = new AuthManager(new SecretStore(context.secrets));
  const tree = new ResourceTreeProvider(profiles);

  context.subscriptions.push(
    vscode.window.registerUriHandler(callbackRouter),

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
      // Explicit profile resolution — no ambient default (NFR-8).
      const all = profiles.list();
      if (all.length === 0) {
        void vscode.window.showInformationMessage(
          "Airdress: there are no profiles to sign out of.",
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        all.map((p) => ({ label: p.label, description: p.fqdn, id: p.id })),
        { placeHolder: "Sign out of which operator profile?" },
      );
      if (!picked) {
        return;
      }
      await auth.signOut(picked.id);
      void vscode.window.showInformationMessage(
        `Airdress: signed out of ${picked.label}.`,
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
