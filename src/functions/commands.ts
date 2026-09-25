import * as vscode from "vscode";
import { clientFor, type ManifestDeps } from "../manifests/diff";
import type { Profile } from "../profiles/model";
import type { ProfileStore } from "../profiles/store";
import type { TreeNodeData } from "../tree/nodes";
import {
  newSourceFunction,
  pickFunctionStart,
  type CreateDeps,
} from "./createPick";
import { deployCheckout, type DeployDeps } from "./deploy";
import {
  checkoutFor,
  treeRootFor,
  type Checkout,
  type SigningChoice,
} from "./local";
import {
  allowAnotherSigner,
  removeSigner,
  type SignerFlowDeps,
} from "./signerFlows";
import {
  createKeychainKey,
  exportKeychainKey,
  keychainKey,
  resolveSigning,
  type SecretStore,
} from "./signingKey";
import {
  adoptFolder,
  checkOut,
  publishCheckout,
  rebaseCheckout,
  servedUri,
  ServedSourceProvider,
  showDifference,
  SOURCE_SCHEME,
  validateOnSave,
  type SourceDeps,
  type SourceUI,
} from "./source";
import { openTemplatePanel } from "./templatePanel";
import {
  pickTemplate,
  type TemplateDeps,
  type TemplateUI,
} from "./templateFlows";
import { readHistory } from "./wire";

/**
 * Wiring for function source and templates: commands, the served-file
 * scheme, the markers, and the one save hook — which only ever runs a
 * dry run (see `validateOnSave`).
 */

export interface FunctionCommandDeps {
  context: vscode.ExtensionContext;
  profiles: ProfileStore;
  manifestDeps: ManifestDeps;
  resolveProfile(explicit?: Profile): Promise<Profile | undefined>;
  /** Today's schema form for a new bundle Function. */
  openBundleForm(profile: Profile): Promise<void>;
  /** Refresh the Resources view after a change it shows. */
  refreshResources(): void;
}

/** What the rest of the extension calls into. */
export interface FunctionCommands {
  /** The "+" on the Function kind: the three-way choice. */
  newFunction(profile: Profile): Promise<void>;
}

/**
 * The signing choice: a key file named in settings, else this
 * workstation's keychain key. Read at each use and held nowhere; the
 * private half never reaches a message, a log or a request.
 */
export async function signingFromSettings(
  secrets: SecretStore,
): Promise<SigningChoice> {
  const cfg = vscode.workspace.getConfiguration("airdress.functions");
  return resolveSigning(
    {
      keyFile: cfg.get<string>("signingKeyFile", ""),
      machine: cfg.get<string>("signerMachine", ""),
    },
    secrets,
  );
}

const vscodeSourceUI: SourceUI = {
  info: (m, ...a) => vscode.window.showInformationMessage(m, ...a),
  warn: (m, ...a) => vscode.window.showWarningMessage(m, ...a),
  error: (m) => void vscode.window.showErrorMessage(m),
  confirm: async (m, action) =>
    (await vscode.window.showWarningMessage(m, { modal: true }, action)) ===
    action,
  pick: (items, placeHolder) =>
    vscode.window.showQuickPick(items, { placeHolder }),
  ask: (prompt, value) =>
    vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true }),
  pickFolder: async (defaultUri) => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri,
      openLabel: "Use This Folder",
    });
    return picked?.[0];
  },
  diff: async (left, right, title) => {
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  },
  open: async (uri) => {
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
      { preview: false },
    );
  },
  status: (m) => void vscode.window.setStatusBarMessage(m, 8000),
};

/** Where a new checkout or fork is offered: `<workspace>/<name>`. */
function defaultFolderFor(name: string): vscode.Uri | undefined {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  return ws ? vscode.Uri.joinPath(ws, name) : undefined;
}

export function registerFunctionCommands(
  deps: FunctionCommandDeps,
): FunctionCommands {
  const { context, profiles, manifestDeps } = deps;
  const secrets: SecretStore = context.secrets;
  const signing = () => signingFromSettings(secrets);
  const createKey = async (): Promise<SigningChoice> => {
    const key = await createKeychainKey(secrets);
    const current = await signing();
    // A key file in settings still wins for signing; the new keychain
    // key is used when there is none.
    return current.key ? current : { ...current, key, origin: "keychain" };
  };
  const diagnostics =
    vscode.languages.createDiagnosticCollection("airdress-source");
  const profileFor = (fqdn: string) => {
    const matches = profiles
      .list()
      .filter((p) => p.fqdn.toLowerCase() === fqdn.toLowerCase());
    return matches.find((p) => p.authMode === "zitadel") ?? matches[0];
  };
  const sourceDeps: SourceDeps = {
    client: (p) => clientFor(manifestDeps, p),
    profileFor,
    pickProfile: () => deps.resolveProfile(),
    diagnostics,
    signing,
    ui: vscodeSourceUI,
  };
  const templateUI: TemplateUI = {
    confirm: vscodeSourceUI.confirm,
    pickFolder: vscodeSourceUI.pickFolder,
    open: vscodeSourceUI.open,
    openDraft: async (yaml) => {
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({
          language: "yaml",
          content: yaml,
        }),
        { preview: false },
      );
    },
    copy: (text) => vscode.env.clipboard.writeText(text),
    pick: (items, placeHolder) =>
      vscode.window.showQuickPick(items, {
        placeHolder,
        matchOnDetail: true,
      }),
    error: vscodeSourceUI.error,
  };
  const templateDeps: TemplateDeps = {
    client: sourceDeps.client,
    signing,
    ui: templateUI,
  };
  const choose = async (
    message: string,
    detail: string,
    ...actions: string[]
  ) =>
    vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      ...actions,
    );
  const signerDeps: SignerFlowDeps = {
    client: sourceDeps.client,
    signing,
    createKey,
    ui: {
      pick: (items, placeHolder) =>
        vscode.window.showQuickPick(items, {
          placeHolder,
          matchOnDetail: true,
        }),
      ask: (prompt, validate) =>
        vscode.window.showInputBox({
          prompt,
          ignoreFocusOut: true,
          validateInput: validate,
        }),
      choose,
      info: (m) => void vscode.window.showInformationMessage(m),
      error: vscodeSourceUI.error,
    },
  };
  const deployDeps: DeployDeps = {
    ...sourceDeps,
    createKey,
    isOwner: (p) => p.authMode === "zitadel",
    choose,
    openDraft: templateUI.openDraft,
    allowSigner: async (p, name, member) => {
      if (
        (await allowAnotherSigner(signerDeps, p, name, member)) === "applied"
      ) {
        deps.refreshResources();
      }
    },
    waitTimeoutMs:
      vscode.workspace
        .getConfiguration("airdress.functions")
        .get<number>("deployWaitSeconds", 60) * 1000,
  };
  const deploy = async (checkout: Checkout) => {
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Deploying ${checkout.record.function}`,
      },
      () => deployCheckout(deployDeps, checkout),
    );
    if (outcome.kind === "deployed" || outcome.kind === "unchanged") {
      deps.refreshResources();
    }
    return outcome;
  };
  const createDeps: CreateDeps = {
    client: sourceDeps.client,
    ui: {
      pick: templateUI.pick,
      ask: (prompt, opts) =>
        vscode.window.showInputBox({
          prompt,
          value: opts?.value,
          ignoreFocusOut: true,
          validateInput: opts?.validate,
        }),
      pickFolder: vscodeSourceUI.pickFolder,
      open: vscodeSourceUI.open,
      info: vscodeSourceUI.info,
      error: vscodeSourceUI.error,
    },
    scratchRoot: (p) =>
      vscode.Uri.joinPath(context.globalStorageUri, "functions", p.fqdn),
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri,
    deploy,
  };
  const functionRow = (node: TreeNodeData) =>
    node?.type === "resource" && node.resource.kind === "Function"
      ? { profile: node.profile, name: node.resource.name }
      : undefined;

  /** The checkout the active editor is in, or a folder to adopt. */
  async function activeCheckout(): Promise<Checkout | undefined> {
    const file = vscode.window.activeTextEditor?.document.uri;
    if (file?.scheme === "file") {
      const found = await checkoutFor(file);
      if (found) {
        return found;
      }
      const root = await treeRootFor(file);
      if (root) {
        return adoptFolder(sourceDeps, root);
      }
    }
    const root = await vscodeSourceUI.pickFolder(
      vscode.workspace.workspaceFolders?.[0]?.uri,
    );
    return root ? adoptFolder(sourceDeps, root) : undefined;
  }

  // One dry run per checkout at a time; a save during one is folded in.
  const inFlight = new Set<string>();

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(
      SOURCE_SCHEME,
      new ServedSourceProvider((id) => {
        const p = profiles.get(id);
        return p ? clientFor(manifestDeps, p) : undefined;
      }),
    ),

    // The one save hook in this extension. It validates through the
    // operator's dry run and can do nothing else: `validateOnSave` fixes
    // `dryRun: true`, and a test holds every request it makes to that.
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const key = doc.uri.toString();
      if (inFlight.has(key)) {
        return;
      }
      inFlight.add(key);
      try {
        await validateOnSave(sourceDeps, doc.uri);
      } finally {
        inFlight.delete(key);
      }
    }),

    vscode.commands.registerCommand(
      "airdress.functions.source.openFile",
      async (node: TreeNodeData) => {
        if (node?.type !== "sourceFile") {
          return;
        }
        await vscodeSourceUI.open(
          servedUri(node.profile.id, node.version, node.path),
        );
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.source.edit",
      async (node: TreeNodeData) => {
        const target =
          node?.type === "resource" && node.resource.kind === "Function"
            ? { profile: node.profile, name: node.resource.name }
            : node?.type === "sourceFile"
              ? { profile: node.profile, name: node.function }
              : undefined;
        if (!target) {
          return;
        }
        try {
          await checkOut(
            sourceDeps,
            target.profile,
            target.name,
            defaultFolderFor(target.name),
          );
        } catch (err) {
          vscodeSourceUI.error(
            `Airdress: reading the source of ${target.name} failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.source.validate",
      async () => {
        const checkout = await activeCheckout();
        if (checkout) {
          await publishCheckout(sourceDeps, checkout, { dryRun: true });
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.source.publish",
      async () => {
        const checkout = await activeCheckout();
        if (checkout) {
          await publishCheckout(sourceDeps, checkout, { dryRun: false });
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.source.showDifference",
      async () => {
        const checkout = await activeCheckout();
        if (!checkout) {
          return;
        }
        const profile = profileFor(checkout.record.operator);
        if (!profile) {
          vscodeSourceUI.error(
            `Airdress: no profile for ${checkout.record.operator}.`,
          );
          return;
        }
        try {
          const { current } = await readHistory(
            clientFor(manifestDeps, profile),
            checkout.record.function,
          );
          if (!current) {
            await vscodeSourceUI.info(
              `Airdress: ${checkout.record.function} serves no source version yet.`,
            );
            return;
          }
          await showDifference(sourceDeps, profile, checkout, current);
        } catch (err) {
          vscodeSourceUI.error(
            `Airdress: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.source.rebase",
      async () => {
        const checkout = await activeCheckout();
        if (checkout) {
          await rebaseCheckout(sourceDeps, checkout);
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.deploy",
      async (target?: vscode.Uri) => {
        let checkout: Checkout | undefined;
        if (target instanceof vscode.Uri && target.scheme === "file") {
          const inside = vscode.Uri.joinPath(target, "function.json");
          checkout = await checkoutFor(inside);
          if (!checkout) {
            const root = await treeRootFor(inside);
            checkout = root ? await adoptFolder(sourceDeps, root) : undefined;
          }
        } else {
          checkout = await activeCheckout();
        }
        if (checkout) {
          await deploy(checkout);
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.signers.allow",
      async (node: TreeNodeData) => {
        const row = functionRow(node);
        if (
          row &&
          (await allowAnotherSigner(signerDeps, row.profile, row.name)) ===
            "applied"
        ) {
          deps.refreshResources();
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.signers.remove",
      async (node: TreeNodeData) => {
        const row = functionRow(node);
        if (
          row &&
          (await removeSigner(signerDeps, row.profile, row.name)) === "applied"
        ) {
          deps.refreshResources();
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.signingKey.export",
      async () => {
        if (!(await keychainKey(secrets))) {
          const made = await choose(
            "This workstation has no signing key in its keychain yet.",
            "Deploy makes one the first time it needs it. Make it now?",
            "Create a Signing Key",
          );
          if (made !== "Create a Signing Key") {
            return;
          }
          await createKeychainKey(secrets);
        }
        const key = await keychainKey(secrets);
        const target = await vscode.window.showSaveDialog({
          title: "Export this workstation's signing key",
          saveLabel: "Export",
        });
        if (!target || !key) {
          return;
        }
        const ok = await choose(
          `Write this workstation's private signing key to ${target.fsPath}?`,
          `Whoever holds the file can sign code that every function allowing key ${key.publicKeyHex} will run. ` +
            "It is written readable by you only; the command line reads it with --signing-key.",
          "Export",
        );
        if (ok !== "Export") {
          return;
        }
        try {
          await exportKeychainKey(secrets, target.fsPath);
          void vscode.window.showInformationMessage(
            `Airdress: exported the signing key (public key ${key.publicKeyHex}) to ${target.fsPath}.`,
          );
        } catch (err) {
          vscodeSourceUI.error(
            `Airdress: exporting the signing key failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "airdress.functions.fromTemplate",
      async () => {
        const profile = await deps.resolveProfile();
        if (!profile) {
          return;
        }
        try {
          const template = await pickTemplate(templateDeps, profile);
          if (template) {
            openTemplatePanel(
              context.extensionUri,
              templateDeps,
              profile,
              template,
              () => defaultFolderFor(template.id),
            );
          }
        } catch (err) {
          vscodeSourceUI.error(
            `Airdress: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),
  );

  return {
    newFunction: async (profile) => {
      const start = await pickFunctionStart(createDeps.ui);
      if (start === "bundle") {
        await deps.openBundleForm(profile);
      } else if (start) {
        try {
          await newSourceFunction(createDeps, profile, start);
        } catch (err) {
          vscodeSourceUI.error(
            `Airdress: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}
