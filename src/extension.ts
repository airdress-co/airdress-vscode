import * as vscode from "vscode";
import {
  OperatorsTreeProvider,
  PrincipalsTreeProvider,
  ResourcesTreeProvider,
} from "./tree/provider";
import { OwnershipTracker } from "./tree/ownership";
import { ProfileStore } from "./profiles/store";
import { addProfile, createStatusBar, pickProfile } from "./profiles/picker";
import { connectAirdress, type HubAirdress } from "./profiles/connect";
import { promptForBearer } from "./auth/bearer";
import {
  breakGlassState,
  breakGlassText,
  breakGlassTooltip,
  classifyBearer,
} from "./auth/breakGlass";
import { runbookUrl } from "./principals/admin";
import { addOpenFileToMapping, detectWorkspaceDrift } from "./drift/commands";
import { AIRDRESS_SCHEME, LiveManifestProvider } from "./manifests/virtual";
import { diffAgainstLive, type ManifestDeps } from "./manifests/diff";
import { applyManifest, validateCommand } from "./manifests/apply";
import { CallbackRouter } from "./auth/zitadel";
import { SecretStore } from "./auth/store";
import { AuthManager } from "./auth/manager";
import { liveFetchers, pingFetcher } from "./tree/fetchers";
import {
  bindOidcIdentity,
  createSubUser,
  defaultAdminUI,
  revokeSubUser,
  showPrincipalMetadata,
  type PrincipalAdminDeps,
} from "./principals/admin";
import type { Profile } from "./profiles/model";
import * as crypto from "node:crypto";
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
    await refreshBreakGlass();
  }

  const adminDeps: PrincipalAdminDeps = {
    manifest: manifestDeps,
    ui: defaultAdminUI,
    // "Add as profile" is the user's separate, deliberate decision to
    // store the credential — never an automatic side effect of create.
    addBearerProfile: async (profile, displayName, token) => {
      const newProfile: Profile = {
        id: crypto.randomUUID(),
        label: `${displayName} @ ${profile.label}`,
        fqdn: profile.fqdn,
        authMode: "bearer",
        dev: profile.dev,
      };
      await profiles.add(newProfile, { allowLocalhost: profile.dev });
      await auth.setBearer(newProfile.id, token);
    },
    copyToClipboard: async (token) => {
      await vscode.env.clipboard.writeText(token);
    },
    refreshPrincipals: () => {
      principalsTree.refresh();
      operatorsTree.refresh();
    },
  };

  function activeProfile(): Profile | undefined {
    const id = profiles.activeId();
    return id ? profiles.get(id) : undefined;
  }

  function refreshAllViews(): void {
    operatorsTree.refresh();
    resourcesTree.refresh();
    principalsTree.refresh();
  }

  // Break-glass indicator: an OWNER session on an opaque bearer is a
  // break-glass session and renders loudly in the status bar, linking
  // to the recovery runbook. Shape only — never any part of the value.
  const breakGlassItem = vscode.window.createStatusBarItem(
    "airdress.breakGlass",
    vscode.StatusBarAlignment.Left,
    49,
  );
  breakGlassItem.name = "Airdress break-glass state";
  breakGlassItem.command = "airdress.breakGlass.openRunbook";
  breakGlassItem.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.warningBackground",
  );
  async function refreshBreakGlass(): Promise<void> {
    const active = activeProfile();
    if (!active) {
      breakGlassItem.hide();
      return;
    }
    const bearer =
      active.authMode === "bearer"
        ? await auth.getAccessToken({ id: active.id, authMode: "bearer" })
        : undefined;
    const state = breakGlassState({
      authMode: active.authMode,
      bearerShape: classifyBearer(bearer),
      isOwner: ownership.known(active.id),
    });
    if (state === "break-glass") {
      breakGlassItem.text = breakGlassText(active.fqdn);
      breakGlassItem.tooltip = breakGlassTooltip(active.fqdn);
      breakGlassItem.show();
    } else {
      breakGlassItem.hide();
    }
  }

  const syncPollerProfile = () => {
    const id = profiles.activeId();
    poller.setActiveProfile(id ? profiles.get(id) : undefined);
  };
  syncPollerProfile();
  poller.setVisible(operatorsView.visible);

  void refreshBreakGlass();

  context.subscriptions.push(
    statusBar.item,
    breakGlassItem,
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
      void refreshBreakGlass();
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

    // First-contact flow: sign in, discover the account's claimed
    // Airdresses from the hub, pick one, get a working profile. On a
    // rejected token or unreachable hub it degrades EXPLICITLY to the
    // manual-hostname path — the message names the reason; nothing
    // falls back silently and no ambient default profile is created.
    vscode.commands.registerCommand("airdress.connectAirdress", async () => {
      await connectAirdress({
        profiles,
        signIn: (profileId) => auth.signInZitadel(profileId, callbackRouter),
        getToken: (profileId) =>
          auth.getAccessToken({ id: profileId, authMode: "zitadel" }),
        discard: (profileId) => auth.signOut(profileId),
        hubUrl: () =>
          vscode.workspace
            .getConfiguration("airdress.hub")
            .get<string>("url", "https://account.airdress.co"),
        ui: {
          pick: async (entries: HubAirdress[]) => {
            const picked = await vscode.window.showQuickPick(
              entries.map((entry) => ({
                label: entry.name,
                description: entry.fqdn,
                detail:
                  entry.dnsStatus && entry.dnsStatus !== "active"
                    ? `DNS status: ${entry.dnsStatus}`
                    : undefined,
                entry,
              })),
              { placeHolder: "Which Airdress should this profile connect to?" },
            );
            return picked?.entry;
          },
          offerManualEntry: async (message) => {
            const choice = await vscode.window.showWarningMessage(
              message,
              "Add by hostname",
            );
            return choice === "Add by hostname";
          },
          addProfileManually: async () => {
            await vscode.commands.executeCommand("airdress.profiles.add");
          },
          info: (message) => void vscode.window.showInformationMessage(message),
          error: (message) => void vscode.window.showErrorMessage(message),
          focusOperatorsView: async () => {
            await vscode.commands.executeCommand("airdress.operators.focus");
          },
        },
      });
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
      void refreshBreakGlass();
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

    // Principal administration. Owner-only by construction: every
    // entry point below is contributed ONLY inside the Principals
    // view, which is absent for non-owners (and all four commands are
    // hidden from the command palette).
    vscode.commands.registerCommand("airdress.principals.create", async () => {
      const profile = activeProfile();
      if (!profile) {
        void vscode.window.showInformationMessage(
          "Airdress: no active profile — pick one in the Operators view first.",
        );
        return;
      }
      await createSubUser(adminDeps, profile);
    }),

    vscode.commands.registerCommand(
      "airdress.principals.revoke",
      async (node: TreeNodeData) => {
        await revokeSubUser(adminDeps, node);
      },
    ),

    vscode.commands.registerCommand(
      "airdress.principals.metadata",
      async (node: TreeNodeData) => {
        await showPrincipalMetadata(
          adminDeps,
          node,
          async (content, principalId) => {
            if (node?.type !== "principal") {
              return;
            }
            const uri = liveProvider.publish(
              node.profile.id,
              "sub-user-metadata",
              principalId,
              content,
            );
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
          },
        );
      },
    ),

    // Drift: an explicit mapping plus a scan that reports and offers
    // diffs — no code path from a scan result to a write exists.
    vscode.commands.registerCommand("airdress.drift.addOpenFile", async () => {
      await addOpenFileToMapping(manifestDeps);
    }),

    vscode.commands.registerCommand("airdress.drift.scan", async () => {
      await detectWorkspaceDrift(manifestDeps);
    }),

    // Break-glass has an EXIT, one click away — and no mint action:
    // owner-token minting requires being on the operator's host.
    vscode.commands.registerCommand(
      "airdress.breakGlass.openRunbook",
      async () => {
        await vscode.env.openExternal(
          vscode.Uri.parse(runbookUrl("ownerRecovery")),
        );
      },
    ),

    vscode.commands.registerCommand(
      "airdress.principals.bind",
      async (node: TreeNodeData) => {
        // Issuer comes from the profile's auth configuration — the
        // user never transcribes a URL.
        const issuer = vscode.workspace
          .getConfiguration("airdress.auth")
          .get<string>("issuer", "");
        await bindOidcIdentity(adminDeps, node, issuer);
      },
    ),
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond context.subscriptions.
}
