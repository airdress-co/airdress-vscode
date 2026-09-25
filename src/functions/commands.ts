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
import { logLineText, shortDigest, type FunctionContext } from "./context";
import {
  AuthoringSchemas,
  createFunctionStatusBar,
  FunctionContextService,
  FunctionLensProvider,
  syncCommittedSigners,
} from "./contextUi";
import { deployCheckout, type DeployDeps } from "./deploy";
import { readLiveFunction } from "./functionManifest";
import {
  checkoutFor,
  markRepositoryFolder,
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
import { promoteVersion, readHistory, refusalOf } from "./wire";

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
  const output = vscode.window.createOutputChannel("Airdress Functions");
  const profileFor = (fqdn: string) => {
    const matches = profiles
      .list()
      .filter((p) => p.fqdn.toLowerCase() === fqdn.toLowerCase());
    return matches.find((p) => p.authMode === "zitadel") ?? matches[0];
  };
  const activeProfile = () => {
    const id = profiles.activeId();
    return id ? profiles.get(id) : undefined;
  };
  const contexts = new FunctionContextService({
    profileFor,
    activeProfile,
    client: (p) => clientFor(manifestDeps, p),
    output,
  });
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
        await signersApplied(p, name);
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
    contexts.invalidateLive(checkout.root.path);
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

  /**
   * A folder the repository itself describes — `function.yaml` names the
   * function and the version git says runs; the map file or the active
   * profile names the operator — needs no question and no record.
   */
  function repositoryCheckout(ctx: FunctionContext): Checkout | undefined {
    if (ctx.checkoutPath || (ctx.nameFrom === "folder" && !ctx.operator)) {
      return undefined;
    }
    const profile = contexts.profileOf(ctx);
    if (!profile) {
      return undefined;
    }
    const root = vscode.Uri.file(ctx.root);
    markRepositoryFolder(root);
    return {
      root,
      record: {
        operator: profile.fqdn,
        function: ctx.name,
        basedOn: ctx.basedOn,
      },
    };
  }

  /** The checkout a file belongs to: its record, the repository, or a folder to adopt. */
  async function checkoutOfFile(
    file: vscode.Uri,
    adopt: boolean,
  ): Promise<Checkout | undefined> {
    const found = await checkoutFor(file);
    if (found) {
      return found;
    }
    const ctx = await contexts.forUri(file);
    const fromRepo = ctx ? repositoryCheckout(ctx) : undefined;
    if (fromRepo || !adopt) {
      return fromRepo;
    }
    const root = await treeRootFor(file);
    return root ? adoptFolder(sourceDeps, root) : undefined;
  }

  /** The checkout the active editor is in, or a folder to adopt. */
  async function activeCheckout(): Promise<Checkout | undefined> {
    const file = vscode.window.activeTextEditor?.document.uri;
    if (file?.scheme === "file") {
      const found = await checkoutOfFile(file, true);
      if (found) {
        return found;
      }
    }
    const root = await vscodeSourceUI.pickFolder(
      vscode.workspace.workspaceFolders?.[0]?.uri,
    );
    return root ? adoptFolder(sourceDeps, root) : undefined;
  }

  /**
   * After a signer-set apply: refresh the view, and write the live set
   * into the committed manifests for this function, so git says who may
   * sign as the operator does.
   */
  async function signersApplied(profile: Profile, name: string): Promise<void> {
    deps.refreshResources();
    contexts.invalidateLive();
    try {
      const live = await readLiveFunction(
        clientFor(manifestDeps, profile),
        name,
      );
      const source = live?.spec.source;
      const signers =
        typeof source === "object" && source !== null
          ? (source as Record<string, unknown>).signers
          : undefined;
      if (!Array.isArray(signers)) {
        return;
      }
      const written = await syncCommittedSigners(
        profile,
        name,
        signers,
        output,
      );
      if (written.length > 0) {
        void vscode.window.setStatusBarMessage(
          `Airdress: wrote the signer set into ${written
            .map((p) => vscode.workspace.asRelativePath(p))
            .join(", ")} — commit it.`,
          10_000,
        );
      }
    } catch (err) {
      output.appendLine(
        `[signers] could not update the committed manifest for ${name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** The active editor's function and the profile it deploys through. */
  async function activeTarget(): Promise<
    { ctx: FunctionContext; profile: Profile } | undefined
  > {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const ctx = uri ? await contexts.forUri(uri) : contexts.current();
    if (!ctx) {
      vscodeSourceUI.error(
        "Airdress: the active editor is not inside a function (no function.json above it).",
      );
      return undefined;
    }
    const profile = contexts.profileOf(ctx) ?? (await deps.resolveProfile());
    if (!profile) {
      return undefined;
    }
    return { ctx, profile };
  }

  /** The function's durable log, newest 200 lines, oldest first. */
  async function showLog(profile: Profile, name: string): Promise<void> {
    const channel = logChannel(name);
    channel.clear();
    channel.show(true);
    channel.appendLine(`${name} on ${profile.fqdn} — the last 200 lines`);
    try {
      const body = await clientFor(manifestDeps, profile).request<unknown>(
        `/v1/functions/${encodeURIComponent(name)}/logs?limit=200`,
      );
      const lines =
        typeof body === "object" &&
        body !== null &&
        Array.isArray((body as Record<string, unknown>).lines)
          ? ((body as Record<string, unknown>).lines as unknown[])
          : [];
      if (lines.length === 0) {
        channel.appendLine("(no lines)");
      }
      for (const line of [...lines].reverse()) {
        channel.appendLine(logLineText(line));
      }
    } catch (err) {
      channel.appendLine(
        `reading the log failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const logChannels = new Map<string, vscode.OutputChannel>();
  function logChannel(name: string): vscode.OutputChannel {
    let channel = logChannels.get(name);
    if (!channel) {
      channel = vscode.window.createOutputChannel(`Airdress: ${name} log`);
      logChannels.set(name, channel);
      context.subscriptions.push(channel);
    }
    return channel;
  }

  /** What the function served and stores; pick one to open, compare or run. */
  async function pickVersion(
    profile: Profile,
    ctx: FunctionContext,
  ): Promise<void> {
    const client = clientFor(manifestDeps, profile);
    let body: Record<string, unknown>;
    try {
      const raw = await client.request<unknown>(
        `/v1/functions/${encodeURIComponent(ctx.name)}/versions`,
      );
      body =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
    } catch (err) {
      vscodeSourceUI.error(
        `Airdress: reading the versions of ${ctx.name} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const current = typeof body.current === "string" ? body.current : null;
    const deployments = Array.isArray(body.deployments) ? body.deployments : [];
    const stored = Array.isArray(body.versions) ? body.versions : [];
    const deployedBy = new Map<string, string>();
    for (const d of deployments as Array<Record<string, unknown>>) {
      if (typeof d.version === "string" && !deployedBy.has(d.version)) {
        deployedBy.set(
          d.version,
          `generation ${String(d.generation)} by ${String(d.actor)} at ${String(d.at)}`,
        );
      }
    }
    const items = (stored as Array<Record<string, unknown>>)
      .filter((v) => typeof v.version === "string")
      .map((v) => {
        const version = v.version as string;
        const tags = [
          version === current ? "runs now" : undefined,
          version === ctx.committedVersion ? "in function.yaml" : undefined,
        ].filter(Boolean);
        return {
          label: `${version === current ? "$(play) " : ""}${shortDigest(version)}`,
          description: tags.join(" · "),
          detail: `published ${String(v.publishedAt)} by ${String(v.publishedBy)}${
            deployedBy.has(version)
              ? ` — deployed ${deployedBy.get(version)}`
              : ""
          }`,
          version,
        };
      });
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        `Airdress: ${ctx.name} stores no source version on ${profile.fqdn}.`,
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${ctx.name} on ${profile.fqdn}: stored versions, newest first`,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    const OPEN = "Open its function.json";
    const COMPARE = "Compare with this folder";
    const RUN = "Run this version (promote)";
    const action = await vscode.window.showQuickPick(
      picked.version === current ? [OPEN, COMPARE] : [OPEN, COMPARE, RUN],
      { placeHolder: shortDigest(picked.version) },
    );
    if (action === OPEN) {
      await vscodeSourceUI.open(
        servedUri(profile.id, picked.version, "function.json"),
      );
    } else if (action === COMPARE) {
      const checkout = await checkoutOfFile(
        vscode.Uri.joinPath(vscode.Uri.file(ctx.root), "function.json"),
        false,
      );
      if (checkout) {
        await showDifference(sourceDeps, profile, checkout, picked.version);
      }
    } else if (action === RUN) {
      const ok = await vscodeSourceUI.confirm(
        `Run ${shortDigest(picked.version)} as ${ctx.name} on ${profile.fqdn}? ` +
          `Only spec.source.version changes; ${shortDigest(current)} stops running. ` +
          "function.yaml in git is not changed — commit the version afterwards.",
        "Promote",
      );
      if (!ok) {
        return;
      }
      try {
        const out = await promoteVersion(client, ctx.name, {
          version: picked.version,
          basedOn: current,
        });
        void vscode.window.showInformationMessage(
          out.changed
            ? `Airdress: ${ctx.name} now runs ${shortDigest(out.version)} (generation ${out.generation ?? "?"}).`
            : `Airdress: ${ctx.name} already ran ${shortDigest(out.version)}.`,
        );
      } catch (err) {
        const refusal = refusalOf(err);
        vscodeSourceUI.error(
          `Airdress: promote refused${refusal ? ` (${refusal.error}): ${refusal.message}` : ` — ${err instanceof Error ? err.message : String(err)}`}`,
        );
      }
      contexts.invalidateLive(ctx.root);
      deps.refreshResources();
    }
  }

  /**
   * The save hook for a folder the repository describes: the same dry
   * run as a checkout's, answered quietly — markers in Problems, words in
   * the output channel, never a dialog on save.
   */
  async function validateRepositoryFolder(file: vscode.Uri): Promise<void> {
    const ctx = await contexts.forUri(file);
    if (!ctx) {
      return;
    }
    const rel = file.path.slice(ctx.root.length + 1);
    if (rel !== "function.json" && !rel.startsWith("src/")) {
      return;
    }
    const checkout = repositoryCheckout(ctx);
    if (!checkout) {
      output.appendLine(
        `[validate] ${ctx.name}: no profile resolves for ${ctx.operator ?? "an operator"}; not checked.`,
      );
      return;
    }
    const say = (m: string) => {
      output.appendLine(`[validate] ${m}`);
      return Promise.resolve(undefined);
    };
    await publishCheckout(
      {
        ...sourceDeps,
        ui: {
          ...vscodeSourceUI,
          info: say,
          warn: say,
          error: (m) => void say(m),
          confirm: async () => false,
          status: (m) => void vscode.window.setStatusBarMessage(m, 5000),
        },
      },
      checkout,
      { dryRun: true },
    );
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
      if (
        !vscode.workspace
          .getConfiguration("airdress.functions")
          .get<boolean>("validateOnSave", true)
      ) {
        return;
      }
      const key = doc.uri.toString();
      if (inFlight.has(key)) {
        return;
      }
      inFlight.add(key);
      try {
        const done = await validateOnSave(sourceDeps, doc.uri);
        if (done === undefined) {
          await validateRepositoryFolder(doc.uri);
        }
      } finally {
        inFlight.delete(key);
      }
      const ctx = await contexts.forUri(doc.uri);
      if (ctx) {
        contexts.invalidateLive(ctx.root);
      }
    }),
    contexts,
    output,
    createFunctionStatusBar(contexts),
    new AuthoringSchemas(contexts),
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: "file", pattern: "**/function.json" },
        { scheme: "file", pattern: "**/function.yaml" },
        { scheme: "file", pattern: "**/src/**/*.{ts,mts,js,mjs}" },
      ],
      new FunctionLensProvider(contexts),
    ),

    vscode.commands.registerCommand("airdress.functions.logs", async () => {
      const target = await activeTarget();
      if (target) {
        await showLog(target.profile, target.ctx.name);
      }
    }),

    vscode.commands.registerCommand("airdress.functions.versions", async () => {
      const target = await activeTarget();
      if (target) {
        await pickVersion(target.profile, target.ctx);
      }
    }),

    vscode.commands.registerCommand(
      "airdress.functions.showOnOperator",
      async () => {
        const target = await activeTarget();
        if (target) {
          await vscode.commands.executeCommand("airdress.resources.open", {
            type: "resource",
            profile: target.profile,
            resource: { kind: "Function", name: target.ctx.name },
          });
        }
      },
    ),

    vscode.commands.registerCommand("airdress.functions.actions", async () => {
      const ctx = contexts.current();
      if (!ctx) {
        return;
      }
      const live = contexts.cachedLive(ctx);
      const items: Array<
        vscode.QuickPickItem & { command: string; args?: unknown[] }
      > = [
        {
          label: "$(rocket) Deploy",
          description: ctx.operator ?? contexts.profileOf(ctx)?.fqdn,
          command: "airdress.functions.deploy",
          args: [vscode.Uri.file(ctx.root)],
        },
        {
          label: "$(check) Validate",
          description: "the operator's checks, nothing stored",
          command: "airdress.functions.source.validate",
        },
        { label: "$(output) Logs", command: "airdress.functions.logs" },
        {
          label: "$(history) Versions",
          description: live?.serving
            ? `serving ${shortDigest(live.serving)}`
            : undefined,
          command: "airdress.functions.versions",
        },
        {
          label: "$(diff) Show the difference with what runs",
          command: "airdress.functions.source.showDifference",
        },
        {
          label: "$(link-external) Show on the operator",
          command: "airdress.functions.showOnOperator",
        },
        {
          label: "$(refresh) Refresh",
          command: "airdress.functions.refreshContext",
        },
      ];
      if (ctx.manifestPath) {
        items.splice(5, 0, {
          label: "$(file-code) Open function.yaml",
          description: "the grant, config and who may sign",
          command: "vscode.open",
          args: [vscode.Uri.file(ctx.manifestPath)],
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `${ctx.name}${ctx.operator ? ` on ${ctx.operator}` : ""}`,
      });
      if (picked) {
        await vscode.commands.executeCommand(
          picked.command,
          ...(picked.args ?? []),
        );
      }
    }),

    vscode.commands.registerCommand("airdress.functions.refreshContext", () => {
      contexts.invalidateLive();
      contexts.scheduleRefresh();
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
          checkout = await checkoutOfFile(
            vscode.Uri.joinPath(target, "function.json"),
            true,
          );
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
          await signersApplied(row.profile, row.name);
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
          await signersApplied(row.profile, row.name);
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
