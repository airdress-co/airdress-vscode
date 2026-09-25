import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as vscode from "vscode";
import { clientFor, type ManifestDeps } from "../manifests/diff";
import type { Profile } from "../profiles/model";
import type { ProfileStore } from "../profiles/store";
import type { TreeNodeData } from "../tree/nodes";
import {
  checkoutFor,
  signingKeyFromSeedText,
  treeRootFor,
  type Checkout,
  type SigningChoice,
} from "./local";
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
}

/**
 * The signing choice from settings. The seed file is read at each use and
 * held nowhere; its bytes never reach a message or a log.
 */
export async function signingFromSettings(): Promise<SigningChoice> {
  const cfg = vscode.workspace.getConfiguration("airdress.functions");
  const keyFile = cfg.get<string>("signingKeyFile", "").trim();
  const machine = cfg.get<string>("signerMachine", "").trim() || undefined;
  if (!keyFile) {
    return { machine };
  }
  const expanded = keyFile.startsWith("~/")
    ? `${os.homedir()}${keyFile.slice(1)}`
    : keyFile;
  let text: string;
  try {
    text = await fs.readFile(expanded, "utf8");
  } catch {
    throw new Error(
      `the signing key file ${keyFile} (airdress.functions.signingKeyFile) cannot be read`,
    );
  }
  return { key: signingKeyFromSeedText(text), machine };
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

export function registerFunctionCommands(deps: FunctionCommandDeps): void {
  const { context, profiles, manifestDeps } = deps;
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
    signing: signingFromSettings,
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
    signing: signingFromSettings,
    ui: templateUI,
  };

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
}
