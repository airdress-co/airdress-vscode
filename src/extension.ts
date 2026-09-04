import * as vscode from "vscode";
import {
  OperatorsTreeProvider,
  PrincipalsTreeProvider,
  ResourcesTreeProvider,
} from "./tree/provider";
import { OwnershipTracker } from "./tree/ownership";
import { ProfileStore } from "./profiles/store";
import { addProfile, createStatusBar, pickProfile } from "./profiles/picker";
import { promptForBearer } from "./auth/bearer";
import { AIRDRESS_SCHEME, LiveManifestProvider } from "./manifests/virtual";
import { diffAgainstLive, type ManifestDeps } from "./manifests/diff";
import { applyManifest, validateCommand } from "./manifests/apply";
import { CallbackRouter } from "./auth/zitadel";
import { SecretStore } from "./auth/store";
import { AuthManager } from "./auth/manager";
import { liveFetchers, pingFetcher } from "./tree/fetchers";
import { HealthPoller } from "./health/poller";
import { StatusCache } from "./health/statusCache";
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
 * a tree expansion, a view becoming visible) explicitly asks for it.
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
  const fetchers = liveFetchers(manifestDeps);

  // Health: liveness polled from the operator's own /v1/ping (active
  // profile only, only while the Operators view is visible);
  // correctness rolled up from the status cache the Resources view
  // fills. This extension reads ONLY the operator's owner-facing API —
  // fleet infrastructure is out of reach by design, and a test
  // enforces that no such call exists.
  const statusCache = new StatusCache();
  const poller = new HealthPoller({
    ping: pingFetcher(manifestDeps),
    intervalMs: () =>
      1000 *
      vscode.workspace
        .getConfiguration("airdress")
        .get<number>("health.intervalSeconds", 60),
  });

  const operatorsTree = new OperatorsTreeProvider(
    profiles,
    (node) =>
      auth.hasCredential({
        id: node.profile.id,
        authMode: node.profile.authMode,
      }),
    {
      livenessFor: (profileId) => poller.livenessFor(profileId),
      correctnessFor: (profileId) => statusCache.correctnessFor(profileId),
    },
  );
  const resourcesTree = new ResourcesTreeProvider(
    profiles,
    fetchers,
    statusCache,
    () => operatorsTree.refresh(),
  );
  const principalsTree = new PrincipalsTreeProvider(profiles, fetchers);
  const ownership = new OwnershipTracker((profile) =>
    fetchers.listPrincipals(profile),
  );

  const operatorsView = vscode.window.createTreeView("airdress.operators", {
    treeDataProvider: operatorsTree,
  });
  const resourcesView = vscode.window.createTreeView("airdress.resources", {
    treeDataProvider: resourcesTree,
  });
  const principalsView = vscode.window.createTreeView("airdress.principals", {
    treeDataProvider: principalsTree,
  });

  /**
   * The Principals view is ABSENT for a non-owner — not empty, not
   * erroring. The ownership probe runs only from user gestures (a view
   * becoming visible, a profile switch while the sidebar is open, an
   * explicit refresh) — never at activation.
   */
  async function updatePrincipalsContext(): Promise<void> {
    const sidebarVisible =
      operatorsView.visible || resourcesView.visible || principalsView.visible;
    const activeId = profiles.activeId();
    const active = activeId ? profiles.get(activeId) : undefined;
    if (!sidebarVisible || !active) {
      await vscode.commands.executeCommand(
        "setContext",
        "airdress.principalsAvailable",
        false,
      );
      return;
    }
    const owner = await ownership.isOwner(active);
    await vscode.commands.executeCommand(
      "setContext",
      "airdress.principalsAvailable",
      owner,
    );
  }

  function refreshAllViews(): void {
    operatorsTree.refresh();
    resourcesTree.refresh();
    principalsTree.refresh();
  }

  const syncPollerProfile = () => {
    const id = profiles.activeId();
    poller.setActiveProfile(id ? profiles.get(id) : undefined);
  };
  syncPollerProfile();
  poller.setVisible(operatorsView.visible);

  context.subscriptions.push(
    statusBar.item,
    operatorsView,
    resourcesView,
    principalsView,
    poller,
    poller.onDidUpdate(() => operatorsTree.refresh()),
    profiles.onDidChange(() => {
      statusBar.refresh();
      refreshAllViews();
      syncPollerProfile();
      void updatePrincipalsContext();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("airdress.health.intervalSeconds")) {
        poller.restart();
      }
    }),
    operatorsView.onDidChangeVisibility(() => {
      // Hiding the view stops ALL health traffic.
      poller.setVisible(operatorsView.visible);
      void updatePrincipalsContext();
    }),
    resourcesView.onDidChangeVisibility(() => void updatePrincipalsContext()),

    vscode.window.registerUriHandler(callbackRouter),

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

    // Operators-view click target: make this profile active. Not in
    // the palette — the palette flow is airdress.profiles.pick.
    vscode.commands.registerCommand(
      "airdress.profiles.activate",
      async (node: TreeNodeData) => {
        if (node?.type !== "profile") {
          return;
        }
        await profiles.setActive(node.profile.id);
      },
    ),

    vscode.commands.registerCommand("airdress.profiles.signOut", async () => {
      // Explicit profile resolution — no ambient default.
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
      ownership.invalidate(picked.id);
      void vscode.window.showInformationMessage(
        `Airdress: signed out of ${picked.label}.`,
      );
      refreshAllViews();
      void updatePrincipalsContext();
    }),

    vscode.commands.registerCommand("airdress.resources.refresh", () => {
      ownership.invalidate();
      statusCache.clear();
      refreshAllViews();
      void updatePrincipalsContext();
    }),

    // Opens the read-only airdress: virtual document for a resource —
    // the same document the diff flow uses as its left side. Writes
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

    // Validate is deliberately a separate command from apply, with no
    // mutating code path — see manifests/apply.ts.
    vscode.commands.registerCommand("airdress.manifests.validate", async () => {
      await validateCommand();
    }),

    // Apply is a deliberate command — deliberately NOT bound to any
    // save event; a test asserts the bundle registers no save listener.
    vscode.commands.registerCommand("airdress.manifests.apply", async () => {
      await applyManifest(manifestDeps);
    }),
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond context.subscriptions.
}
