import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import { publishTemplateConfirm, targetPhrase } from "../profiles/confirm";
import {
  CHECKOUT_FILE,
  MANIFEST_FILE,
  publishBody,
  type SigningChoice,
} from "./local";
import {
  capabilitiesSuggestion,
  configEntries,
  forkFiles,
  GRANT_EXPLANATION,
  manifestDraft,
  type FormValues,
  type SignerNaming,
} from "./templates";
import {
  isStaleBase,
  listTemplates,
  publishSource,
  readTemplate,
  refusalOf,
  type Template,
} from "./wire";

/**
 * What the template panel does when a button is pressed. Each action
 * answers with one sentence for the panel to show; nothing here writes
 * `spec.capabilities` anywhere.
 */

export interface TemplateUI {
  confirm(message: string, action: string): Thenable<boolean>;
  pickFolder(defaultUri?: vscode.Uri): Thenable<vscode.Uri | undefined>;
  open(uri: vscode.Uri): Thenable<void>;
  /** Open text as an untitled YAML document. */
  openDraft(yaml: string): Thenable<void>;
  copy(text: string): Thenable<void>;
  pick<T extends vscode.QuickPickItem>(
    items: T[],
    placeHolder: string,
  ): Thenable<T | undefined>;
  error(message: string): void;
}

export interface TemplateDeps {
  client(profile: Profile): ApiClient;
  signing(): Promise<SigningChoice>;
  ui: TemplateUI;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** How the manifest names the signer the editor signs with. */
export function signerNaming(signing: SigningChoice): SignerNaming {
  if (signing.machine) {
    return { signerRef: { machine: signing.machine } };
  }
  if (signing.key) {
    return { signer: signing.key.publicKeyHex };
  }
  return {};
}

/**
 * The catalogue as a quick pick, then the chosen template with its files.
 * A 404 means the operator serves no templates — said, not thrown.
 */
export async function pickTemplate(
  deps: TemplateDeps,
  profile: Profile,
): Promise<Template | undefined> {
  const client = deps.client(profile);
  let catalogue;
  try {
    catalogue = await listTemplates(client);
  } catch (err) {
    deps.ui.error(
      `Airdress: ${targetPhrase(profile)} did not list function templates — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
  const picked = await deps.ui.pick(
    catalogue.map((t) => ({
      label: t.title,
      description: t.id,
      detail: t.description,
      id: t.id,
    })),
    `Start a function from a template on ${profile.label}`,
  );
  return picked ? readTemplate(client, picked.id) : undefined;
}

/** The panel's opening message: the template, and the grant to show. */
export function templateView(template: Template): {
  grantYaml: string;
  grantExplanation: string;
} {
  return {
    grantYaml: capabilitiesSuggestion(template.requires),
    grantExplanation: GRANT_EXPLANATION,
  };
}

/**
 * Publish the template's tree as it is, under `name`, then open a draft
 * manifest naming the version, the signer and the form's configuration.
 * The draft carries the grant only as commented YAML.
 */
export async function createFromTemplate(
  deps: TemplateDeps,
  profile: Profile,
  template: Template,
  name: string,
  values: FormValues,
): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, message: "Name the function first." };
  }
  const config = configEntries(template.config.fields, values);
  if (config.missing.length > 0 || config.invalid.length > 0) {
    return {
      ok: false,
      message: [
        config.missing.length
          ? `Required: ${config.missing.join(", ")}.`
          : undefined,
        ...config.invalid,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (
    !(await deps.ui.confirm(
      publishTemplateConfirm(template.title, trimmed, profile),
      "Publish",
    ))
  ) {
    return { ok: false, message: "Nothing was published." };
  }
  const signing = await deps.signing();
  const tree = new Map(
    Object.entries(template.files).map(([p, c]) => [
      p,
      new Uint8Array(Buffer.from(c, "utf8")),
    ]),
  );
  let version: string;
  try {
    const published = await publishSource(
      deps.client(profile),
      publishBody(trimmed, null, tree, signing),
      { dryRun: false },
    );
    version = published.version;
  } catch (err) {
    const refusal = refusalOf(err);
    if (isStaleBase(refusal)) {
      return {
        ok: false,
        message:
          `A function named ${trimmed} already serves a version on ${profile.fqdn}. ` +
          "Pick another name — or check that function out and edit it.",
      };
    }
    if (refusal) {
      const where = refusal.locations
        .map((l) => `${l.path}${l.line ? `:${l.line}` : ""}`)
        .join(", ");
      return {
        ok: false,
        message: `Refused (${refusal.error}): ${refusal.message}${where ? ` at ${where}` : ""}`,
      };
    }
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  await deps.ui.openDraft(
    manifestDraft({
      name: trimmed,
      version,
      signer: signerNaming(signing),
      config: config.entries,
      requires: template.requires,
    }),
  );
  return {
    ok: true,
    message:
      `Published as ${version}. The manifest draft is open: add the grants it ` +
      "needs, then apply it with Airdress: Apply Manifest to Operator.",
  };
}

/**
 * Write the template's files into a folder as ordinary source. The folder
 * must not already hold a tree; nothing is written that names the
 * template, and no checkout record is made — the fork belongs to no
 * function until someone publishes it as one.
 */
export async function forkTemplate(
  deps: TemplateDeps,
  template: Template,
  defaultFolder?: vscode.Uri,
): Promise<ActionResult> {
  const root = await deps.ui.pickFolder(defaultFolder);
  if (!root) {
    return { ok: false, message: "Nothing was written." };
  }
  for (const occupied of [MANIFEST_FILE, CHECKOUT_FILE]) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, occupied));
      return {
        ok: false,
        message: `${root.fsPath} already holds ${occupied}. Pick an empty folder.`,
      };
    } catch {
      // absent: good
    }
  }
  const files = forkFiles(template.files);
  for (const f of files) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, ...f.path.split("/")),
      Buffer.from(f.content, "utf8"),
    );
  }
  await deps.ui.open(
    vscode.Uri.joinPath(root, ...(template.entry || MANIFEST_FILE).split("/")),
  );
  return {
    ok: true,
    message: `Wrote ${files.length} files to ${root.fsPath}. They are yours now: edit them, then Airdress: Publish Function Source.`,
  };
}
