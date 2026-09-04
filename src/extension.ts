import * as vscode from "vscode";
import { ResourceTreeProvider } from "./tree/provider";
import { ProfileStore } from "./profiles/store";
import { addProfile, createStatusBar, pickProfile } from "./profiles/picker";
import { promptForBearer } from "./auth/bearer";
import { AIRDRESS_SCHEME, LiveManifestProvider } from "./manifests/virtual";
import { diffAgainstLive, type ManifestDeps } from "./manifests/diff";
import { applyManifest, validateCommand } from "./manifests/apply";
import { CallbackRouter } from "./auth/zitadel";
import { SecretStore } from "./auth/store";
import { AuthManager } from "./auth/manager";
import { liveFetchers } from "./tree/fetchers";
import type { TreeNodeData } from "./tree/nodes";
import { clientFor } from "./manifests/diff";
import * as YAML from "yaml";

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
  const statusBar = createStatusBar(profiles);
  const liveProvider = new LiveManifestProvider();
  const manifestDeps: ManifestDeps = {
    profiles,
    auth,
    provider: liveProvider,
  };
  const tree = new ResourceTreeProvider(profiles, liveFetchers(manifestDeps));

  context.subscriptions.push(
    statusBar.item,
    profiles.onDidChange(() => {
      statusBar.refresh();
      tree.refresh();
    }),

    vscode.window.registerUriHandler(callbackRouter),

    vscode.window.registerTreeDataProvider("airdress.resources", tree),

    vscode.commands.registerCommand("airdress.profiles.add", async () => {
      const profile = await addProfile(profiles);
      if (!profile) {
        return;
      }
      // Offer the matching credential entry immediately; both flows are
      // cancellable — a profile without a credential is fine.
      try {
        if (profile.authMode === "zitadel") {
          await auth.signInZitadel(profile.id, callbackRouter);
          void vscode.window.showInformationMessage(
            `Airdress: signed in to ${profile.label}.`,
          );
        } else {
          const bearer = await promptForBearer();
          if (bearer) {
            await auth.setBearer(profile.id, bearer);
          }
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Airdress: sign-in for ${profile.label} failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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

    // Opens the read-only airdress: virtual document for a resource —
    // the same document T6-04's diff uses as its left side. Writes
    // nothing to disk.
    vscode.commands.registerCommand(
      "airdress.resources.open",
      async (node: TreeNodeData) => {
        if (node?.type !== "resource") {
          return;
        }
        const { profile, resource } = node;
        try {
          const live = await clientFor(manifestDeps, profile).request<unknown>(
            `/v1/kinds/${encodeURIComponent(resource.kind)}/${encodeURIComponent(resource.name)}`,
          );
          const uri = liveProvider.publish(
            profile.id,
            resource.kind,
            resource.name,
            YAML.stringify(live),
          );
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Airdress: opening ${resource.kind}/${resource.name} from ${profile.fqdn} failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    ),

    vscode.workspace.registerTextDocumentContentProvider(
      AIRDRESS_SCHEME,
      liveProvider,
    ),

    vscode.commands.registerCommand("airdress.manifests.diff", async () => {
      await diffAgainstLive(manifestDeps);
    }),

    vscode.commands.registerCommand("airdress.manifests.validate", async () => {
      await validateCommand();
    }),

    // Apply is a deliberate command — deliberately NOT bound to any
    // save event (design §5.2); a test asserts the bundle registers no
    // save listener.
    vscode.commands.registerCommand("airdress.manifests.apply", async () => {
      await applyManifest(manifestDeps);
    }),
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond context.subscriptions.
}
