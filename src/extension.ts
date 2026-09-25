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
import {
  defaultEnrollmentRevokeUI,
  revokeEnrollment,
  type EnrollmentRevokeDeps,
} from "./enrollments/revoke";
import { addOpenFileToMapping, detectWorkspaceDrift } from "./drift/commands";
import { AIRDRESS_SCHEME, LiveManifestProvider } from "./manifests/virtual";
import { diffAgainstLive, type ManifestDeps } from "./manifests/diff";
import { applyManifest, validateCommand } from "./manifests/apply";
import { CallbackRouter, type SignInOptions } from "./auth/zitadel";
import { AccountMismatchError, identityText } from "./auth/identity";
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
import { deleteResourcePrompt } from "./profiles/confirm";
import { SELECTOR_VIEW_ID, SelectorViewProvider } from "./selector/view";
import * as crypto from "node:crypto";
import { HealthPoller } from "./health/poller";
import { StatusCache } from "./health/statusCache";
import type { TreeNodeData } from "./tree/nodes";
import { clientFor } from "./manifests/diff";
import { resolveProfile } from "./profiles/picker";
import { bundledSchemas } from "./manifests/schemas";
import {
  newFunctionCommand,
  newResourceCommand,
  openResourcePanel,
  type ResourcePanelDeps,
  drivePanel,
} from "./webview/panel";
import * as YAML from "yaml";
import {
  registerFunctionCommands,
  type FunctionCommands,
} from "./functions/commands";

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
/**
 * The profile a command was invoked ON, if any: a tree row's profile, or
 * a Profile passed as an argument (the selector view, a script). Any
 * other node type names no profile.
 */
export function explicitProfile(
  target: Profile | TreeNodeData | undefined,
): Profile | undefined {
  if (!target) {
    return undefined;
  }
  if ("type" in target) {
    return target.type === "profile" ? target.profile : undefined;
  }
  return target;
}

export function activate(context: vscode.ExtensionContext): void {
  const profiles = new ProfileStore(context.globalState);
  const auth = new AuthManager(new SecretStore(context.secrets));
  // One row per airdress. An older build minted a twin on every
  // re-sign-in; collapse them once, keeping the row that can still
  // reach the operator, and clear the losers' secrets.
  void profiles
    .dedupe(
      (p) => auth.hasCredential({ id: p.id, authMode: p.authMode }),
      (id) => auth.signOut(id),
    )
    .then((merged) => {
      if (merged.length > 0) {
        void vscode.window.showInformationMessage(
          `Airdress: merged duplicate profiles for ${merged
            .map((m) => m.kept.fqdn)
            .join(", ")} — one row per airdress now.`,
        );
      }
    });
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

  // The selector: which airdress is current, reachability and credential
  // state as facts. Its probe is one authenticated read per activation
  // and per switch, only while visible.
  const selector = new SelectorViewProvider({
    profiles,
    auth,
    poller,
    probe: async (profile) => {
      await fetchers.listKinds(profile);
    },
    extensionUri: context.extensionUri,
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
  // Set once function commands are registered, below; the "+" reads it.
  const functions: { commands?: FunctionCommands } = {};
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

  const enrollmentRevokeDeps: EnrollmentRevokeDeps = {
    manifest: manifestDeps,
    ui: defaultEnrollmentRevokeUI,
    refreshResources: () => resourcesTree.refresh(),
  };

  function activeProfile(): Profile | undefined {
    const id = profiles.activeId();
    return id ? profiles.get(id) : undefined;
  }

  const resourcePanelDeps: ResourcePanelDeps = {
    manifest: manifestDeps,
    extensionUri: context.extensionUri,
  };

  function refreshAllViews(): void {
    operatorsTree.refresh();
    resourcesTree.refresh();
    principalsTree.refresh();
  }

  /**
   * Connect an Airdress. `pick` overrides the airdress quick-pick — the
   * dev-mode `airdress.dev.connectAirdress(fqdn)` passes one that
   * selects by FQDN, because a quick-pick is not reachable by command.
   */
  async function runConnect(
    pick?: (entries: HubAirdress[]) => Promise<HubAirdress | undefined>,
    trace?: string[],
  ): Promise<void> {
    await connectAirdress({
      profiles,
      // Connecting an airdress is a flow that CHOOSES an account, so it
      // always asks which one — this extension knowing of only one says
      // nothing about how many the browser is signed into.
      signIn: (profileId) =>
        auth.signInZitadel(profileId, callbackRouter, {
          prompt: "select_account",
        }),
      getToken: (profileId) =>
        auth.getAccessToken({ id: profileId, authMode: "zitadel" }),
      discard: (profileId) => auth.signOut(profileId),
      adopt: (fromId, toId, expected) =>
        auth.adoptCredential(fromId, toId, expected),
      identityOf: (profileId) => auth.identityFor(profileId),
      hubUrl: () =>
        vscode.workspace
          .getConfiguration("airdress.hub")
          .get<string>("url", "https://account.airdress.co"),
      ui: {
        pick:
          (pick
            ? async (entries: HubAirdress[]) => {
                trace?.push(
                  `entries: ${entries.map((e) => e.fqdn).join(", ")}`,
                );
                return pick(entries);
              }
            : undefined) ??
          (async (entries: HubAirdress[]) => {
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
          }),
        offerManualEntry: async (message) => {
          trace?.push(`manual offered: ${message}`);
          const choice = await vscode.window.showWarningMessage(
            message,
            "Add by hostname",
          );
          return choice === "Add by hostname";
        },
        addProfileManually: async () => {
          await vscode.commands.executeCommand("airdress.profiles.add");
        },
        info: (message) => {
          trace?.push(`info: ${message}`);
          void vscode.window.showInformationMessage(message);
        },
        error: (message) => {
          trace?.push(`error: ${message}`);
          void vscode.window.showErrorMessage(message);
        },
        focusOperatorsView: async () => {
          await vscode.commands.executeCommand("airdress.operators.focus");
        },
      },
    });
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
    vscode.window.registerWebviewViewProvider(SELECTOR_VIEW_ID, selector),
    auth.onDidChangeCredential(() => selector.refresh()),
    poller.onDidUpdate(() => selector.refresh()),
    vscode.commands.registerCommand("airdress.selector.refresh", () => {
      selector.onActiveChanged();
    }),
    operatorsView,
    resourcesView,
    principalsView,
    poller,
    poller.onDidUpdate(() => operatorsTree.refresh()),
    profiles.onDidChange(() => {
      selector.onActiveChanged();
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
          await auth.signInZitadel(profile.id, callbackRouter, {
            prompt: "select_account",
          });
          const identity = auth.identityFor(profile.id);
          if (identity) {
            await profiles.setAccount(profile.id, identity);
          }
          void vscode.window.showInformationMessage(
            `Airdress: signed in to ${profile.label} as ${identityText(
              identity,
            )}.`,
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
    vscode.commands.registerCommand("airdress.connectAirdress", () =>
      runConnect(),
    ),

    vscode.commands.registerCommand("airdress.profiles.pick", async () => {
      await pickProfile(profiles);
    }),

    // "Sign in again" for a profile whose credential died — on the SAME
    // profile id. Until this existed the only sign-in paths minted a
    // new profile, which is how the tree grew twin rows. ZITADEL goes
    // through a throwaway candidate id and adopts the result, so a
    // cancelled browser flow leaves the profile exactly as it was.
    vscode.commands.registerCommand(
      "airdress.profiles.signInAgain",
      async (target?: Profile | TreeNodeData) => {
        const profile = await resolveProfile(profiles, explicitProfile(target));
        if (!profile) {
          return;
        }
        try {
          if (profile.authMode === "zitadel") {
            // Re-acquiring a credential for an account this profile is
            // already bound to: no chooser on the first try, because
            // the usual case is the same person whose refresh token
            // died, and `login_hint` names who is expected. The check
            // in adoptCredential is what makes that safe — and when it
            // does catch a different account, the chooser is offered
            // rather than the flow simply failing.
            const hint = profile.account?.label;
            const signInOnce = async (
              options: SignInOptions,
            ): Promise<void> => {
              const candidate = crypto.randomUUID();
              try {
                await auth.signInZitadel(candidate, callbackRouter, options);
                await auth.adoptCredential(
                  candidate,
                  profile.id,
                  profile.account,
                );
                const identity = auth.identityFor(profile.id);
                if (identity) {
                  await profiles.setAccount(profile.id, identity);
                }
              } catch (err) {
                await auth.signOut(candidate);
                throw err;
              }
            };
            try {
              await signInOnce({ loginHint: hint });
            } catch (err) {
              if (!(err instanceof AccountMismatchError)) {
                throw err;
              }
              const choose = await vscode.window.showWarningMessage(
                err.message,
                "Choose account",
              );
              if (choose !== "Choose account") {
                return;
              }
              await signInOnce({ prompt: "select_account", loginHint: hint });
            }
          } else {
            const bearer = await promptForBearer();
            if (!bearer) {
              return;
            }
            await auth.setBearer(profile.id, bearer);
          }
          void vscode.window.showInformationMessage(
            `Airdress: signed in again to ${profile.label} (${profile.fqdn})` +
              `${
                profile.authMode === "zitadel"
                  ? ` as ${identityText(auth.identityFor(profile.id))}`
                  : ""
              }.`,
          );
          refreshAllViews();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Airdress: sign-in for ${profile.label} failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    ),

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

    // Sign-out is the one command that still ASKS with no explicit
    // target: dropping a credential should never ride on whichever
    // airdress happened to be active. A tree row or an argument names
    // its target and skips the pick.
    vscode.commands.registerCommand(
      "airdress.profiles.signOut",
      async (target?: Profile | TreeNodeData) => {
        const all = profiles.list();
        if (all.length === 0) {
          void vscode.window.showInformationMessage(
            "Airdress: there are no profiles to sign out of.",
          );
          return;
        }
        const explicit = explicitProfile(target);
        const picked =
          explicit ??
          (await vscode.window.showQuickPick(
            all.map((p) => ({ label: p.label, description: p.fqdn, id: p.id })),
            { placeHolder: "Sign out of which operator profile?" },
          ));
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
      },
    ),

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
    // save event; the one save listener (function source) only dry-runs.
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

    // Enrollment revoke: offered on every Enrollments row; whether this
    // sign-in may revoke that device is the operator's decision.
    vscode.commands.registerCommand(
      "airdress.enrollments.revoke",
      async (node: TreeNodeData) => {
        await revokeEnrollment(enrollmentRevokeDeps, node);
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

    // Function configuration panel. The context-menu entry is contributed
    // ONLY against Function rows (viewItem == airdressResource.Function)
    // and hidden from the palette; the palette entry opens an empty
    // draft after an explicit profile pick. Apply from the panel goes
    // through the same applyManifest flow as a file — one apply path.
    vscode.commands.registerCommand(
      "airdress.functions.configure",
      async (node: TreeNodeData) => {
        if (node?.type !== "resource" || node.resource.kind !== "Function") {
          return;
        }
        await openResourcePanel(
          resourcePanelDeps,
          node.profile,
          node.resource.kind,
          node.resource.name,
        );
      },
    ),

    // The "+" for a Function: from a template, blank, or a bundle (the
    // schema form, unchanged). Other kinds keep the form.
    vscode.commands.registerCommand("airdress.functions.new", async () => {
      const profile = await resolveProfile(profiles);
      if (profile && functions.commands) {
        await functions.commands.newFunction(profile);
      } else if (profile) {
        await newFunctionCommand(resourcePanelDeps);
      }
    }),

    // Generic CRUD. The tree lists every registered Kind but
    // could only ever CREATE a Function, never edit one in place, and
    // never called the DELETE the operator has offered all along.
    // These three close that, over the unchanged API.
    vscode.commands.registerCommand("airdress.resources.create", async () => {
      const profile = await resolveProfile(profiles);
      if (!profile) {
        return;
      }
      // The operator is the authority on which Kinds it registers; the
      // bundled schemas are the fallback when it cannot be reached, so
      // "create" still works offline for the Kinds we ship forms for.
      let kinds: string[];
      try {
        kinds = await fetchers.listKinds(profile);
      } catch {
        kinds = bundledSchemas().map((s) => s.kind);
      }
      if (kinds.length === 0) {
        void vscode.window.showWarningMessage(
          `Airdress: ${profile.label} registers no kinds to create.`,
        );
        return;
      }
      const kind = await vscode.window.showQuickPick(kinds.sort(), {
        placeHolder: "Which kind of resource?",
      });
      if (!kind) {
        return;
      }
      if (kind === "Function" && functions.commands) {
        await functions.commands.newFunction(profile);
        return;
      }
      await newResourceCommand(resourcePanelDeps, kind);
    }),

    vscode.commands.registerCommand(
      "airdress.resources.edit",
      async (node: TreeNodeData) => {
        if (node?.type !== "resource") {
          return;
        }
        await openResourcePanel(
          resourcePanelDeps,
          node.profile,
          node.resource.kind,
          node.resource.name,
        );
      },
    ),

    // Type-to-confirm, naming Kind, name, profile and FQDN. A row is one
    // click from a reconciled resource disappearing, so the confirm asks
    // for the name rather than a yes (FR-4, NFR-6).
    vscode.commands.registerCommand(
      "airdress.resources.delete",
      async (node: TreeNodeData) => {
        if (node?.type !== "resource") {
          return;
        }
        const { kind, name } = node.resource;
        const typed = await vscode.window.showInputBox({
          title: `Delete ${kind}/${name}?`,
          prompt: deleteResourcePrompt(kind, name, node.profile),
          placeHolder: name,
          ignoreFocusOut: true,
          validateInput: (v) =>
            v === name
              ? undefined
              : `Type "${name}" exactly, or Escape to cancel.`,
        });
        if (typed !== name) {
          return;
        }
        try {
          await clientFor(manifestDeps, node.profile).send(
            `/v1/kinds/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
            { method: "DELETE" },
          );
          void vscode.window.showInformationMessage(
            `Airdress: deleted ${kind}/${name} from ${node.profile.label}.`,
          );
          resourcesTree.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Airdress: could not delete ${kind}/${name} — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    ),

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

  // Function source and templates: the editing loop, the served-file
  // scheme, and the single save hook (dry run only).
  functions.commands = registerFunctionCommands({
    context,
    profiles,
    manifestDeps,
    resolveProfile: (explicit) => resolveProfile(profiles, explicit),
    openBundleForm: async (profile) => {
      await openResourcePanel(
        resourcePanelDeps,
        profile,
        "Function",
        undefined,
      );
    },
    refreshResources: () => resourcesTree.refresh(),
  });

  // Development-mode only: a script's way into an open panel — the same
  // receive path as the webview's own messages, returning what the host
  // posted back (see `drivePanel`). A release build never registers it,
  // so it is absent from the command table, not merely hidden.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "airdress.dev.drivePanel",
        (...args: Parameters<typeof drivePanel>) => drivePanel(...args),
      ),
      // The quick-picks in front of a draft (profile, then Kind) are
      // VS Code chrome a script cannot answer; this opens the same
      // panel `airdress.resources.create` opens once they are answered.
      vscode.commands.registerCommand("airdress.dev.selectorState", () =>
        selector.state(),
      ),
      // Connect with the airdress pick answered by FQDN (the pick itself
      // is VS Code chrome no command can accept). The browser sign-in
      // still happens; only the list is pre-answered.
      vscode.commands.registerCommand(
        "airdress.dev.connectAirdress",
        async (fqdn: string) => {
          const trace: string[] = [];
          await runConnect(
            async (entries) =>
              entries.find((e) => e.fqdn.toLowerCase() === fqdn.toLowerCase()),
            trace,
          );
          return trace;
        },
      ),
      vscode.commands.registerCommand(
        "airdress.dev.openPanel",
        async (profile: Profile, kind: string, name?: string) => {
          const panel = await openResourcePanel(
            resourcePanelDeps,
            profile,
            kind,
            name,
          );
          return panel.title;
        },
      ),
    );
  }
}

export function deactivate(): void {
  // Nothing to dispose beyond context.subscriptions.
}
