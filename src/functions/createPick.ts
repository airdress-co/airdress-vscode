import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import { targetPhrase } from "../profiles/confirm";
import { OWNER_MANIFEST_FILE, ownerManifestDraft } from "./functionManifest";
import {
  CHECKOUT_FILE,
  MANIFEST_FILE,
  writeCheckout,
  type Checkout,
} from "./local";
import { configEntries, forkFiles, type FormValues } from "./templates";
import type { TemplateField } from "./templateTypes";
import { defaultFunctionId } from "./templateProtocol";
import { listTemplates, readTemplate, type Template } from "./wire";

/**
 * The "+" on the Function kind: start from working code.
 *
 *   From a template        the operator's catalogue, then a name
 *   Blank source function  the operator's `blank` template
 *   Bundle (advanced)      the schema form, unchanged
 *
 * The first two write ordinary source files into a folder — a scratch
 * folder by default — with `function.yaml` beside them, and offer
 * Deploy. No template lives in this extension: the catalogue and every
 * file come from the operator. Nothing is sent until Deploy, and the
 * grant a template asks for is sent only through Deploy's create prompt,
 * which shows it in full.
 */

export type FunctionStart = "template" | "blank" | "bundle";

/** The template id the operator serves the blank function under. */
export const BLANK_TEMPLATE_ID = "blank";

export const START_CHOICES: ReadonlyArray<{
  readonly label: string;
  readonly detail: string;
  readonly start: FunctionStart;
}> = [
  {
    label: "From a template",
    detail: "Start from working code the operator ships.",
    start: "template",
  },
  {
    label: "Blank source function",
    detail: "One file that answers a request.",
    start: "blank",
  },
  {
    label: "Bundle (advanced)",
    detail: "A prebuilt WebAssembly component, configured in a form.",
    start: "bundle",
  },
];

export interface CreateUI {
  pick<T extends vscode.QuickPickItem>(
    items: T[],
    placeHolder: string,
  ): Thenable<T | undefined>;
  ask(
    prompt: string,
    opts?: { value?: string; validate?: (v: string) => string | undefined },
  ): Thenable<string | undefined>;
  pickFolder(defaultUri?: vscode.Uri): Thenable<vscode.Uri | undefined>;
  open(uri: vscode.Uri): Thenable<void>;
  info(message: string, ...actions: string[]): Thenable<string | undefined>;
  error(message: string): void;
}

export interface CreateDeps {
  client(profile: Profile): ApiClient;
  ui: CreateUI;
  /** Where a scratch folder for a new function goes. */
  scratchRoot(profile: Profile): vscode.Uri;
  /** The workspace folder to suggest instead, if one is open. */
  workspaceRoot(): vscode.Uri | undefined;
  /** Run Deploy for the new folder. */
  deploy(checkout: Checkout): Promise<unknown>;
}

/** Ask which of the three to create. */
export async function pickFunctionStart(
  ui: Pick<CreateUI, "pick">,
): Promise<FunctionStart | undefined> {
  const picked = await ui.pick(
    START_CHOICES.map((c) => ({ ...c })),
    "New Function",
  );
  return picked?.start;
}

/**
 * A function name the operator will take as `metadata.name` and as its
 * route: lowercase letters, digits and dashes.
 */
export function functionNameProblem(name: string): string | undefined {
  if (!name) {
    return "Name the function.";
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    return "Lowercase letters, digits and dashes, not starting or ending with a dash (at most 63).";
  }
  return undefined;
}

export const SCRATCH_FOLDER = "Scratch folder (default)";
export const WORKSPACE_FOLDER = "Open in a workspace folder instead";
export const DEPLOY_NOW = "Deploy";

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** `<root>/<name>`, or `<name>-2`, `-3`… when that is taken. */
async function freeFolder(root: vscode.Uri, name: string): Promise<vscode.Uri> {
  for (let i = 1; i < 100; i++) {
    const candidate = vscode.Uri.joinPath(
      root,
      i === 1 ? name : `${name}-${i}`,
    );
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  return vscode.Uri.joinPath(root, `${name}-${Date.now()}`);
}

/**
 * The template's configuration form, one question per field. A secret
 * field asks for the NAME of a secret on the operator, never its value.
 */
async function askConfig(
  ui: CreateUI,
  fields: readonly TemplateField[],
): Promise<FormValues | undefined> {
  const values: Record<string, string | boolean | undefined> = {};
  for (const field of fields) {
    const label = `${field.name}${field.required ? "" : " (optional)"}`;
    if (field.type === "boolean") {
      const picked = await ui.pick(
        [
          { label: "Yes", value: true },
          { label: "No", value: false },
          ...(field.required
            ? []
            : [{ label: "Leave unset", value: undefined }]),
        ],
        `${label} — ${field.description}`,
      );
      if (!picked) {
        return undefined;
      }
      values[field.name] = picked.value;
      continue;
    }
    const prompt =
      field.type === "secret"
        ? `${label} — ${field.description} Name the secret on the operator that holds it; the value is never typed here.`
        : `${label} — ${field.description}`;
    const answer = await ui.ask(prompt, {
      value:
        field.default !== undefined && field.type !== "secret"
          ? String(field.default)
          : undefined,
      validate: (v) =>
        field.required && v.trim() === ""
          ? `${field.name} is required.`
          : field.type === "number" &&
              v.trim() !== "" &&
              !Number.isFinite(Number(v))
            ? `${field.name} is a number.`
            : undefined,
    });
    if (answer === undefined) {
      return undefined;
    }
    values[field.name] = answer;
  }
  return values;
}

/**
 * From a template, or blank: pick, name, scaffold, configure, then offer
 * Deploy. Returns the new folder, or undefined when anything was
 * cancelled or refused (said to the person first).
 */
export async function newSourceFunction(
  deps: CreateDeps,
  profile: Profile,
  start: "template" | "blank",
): Promise<Checkout | undefined> {
  const { ui } = deps;
  const client = deps.client(profile);
  let templateId = BLANK_TEMPLATE_ID;
  if (start === "template") {
    let catalogue;
    try {
      catalogue = await listTemplates(client);
    } catch (err) {
      ui.error(
        `Airdress: ${targetPhrase(profile)} did not list function templates — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
    // "Blank" is its own choice on the "+"; the list is the rest.
    const offered = catalogue.filter((t) => t.id !== BLANK_TEMPLATE_ID);
    if (offered.length === 0) {
      ui.error(`Airdress: ${targetPhrase(profile)} serves no templates.`);
      return undefined;
    }
    const picked = await ui.pick(
      offered.map((t) => ({
        label: t.title,
        description: t.id,
        detail: t.description,
        id: t.id,
      })),
      `Start a function from a template on ${profile.label}`,
    );
    if (!picked) {
      return undefined;
    }
    templateId = picked.id;
  }

  const name = (
    await ui.ask(
      `Name the new function on ${profile.label} — it is served at /fn/<name>.`,
      { validate: (v) => functionNameProblem(v.trim()) },
    )
  )?.trim();
  if (!name || functionNameProblem(name)) {
    return undefined;
  }

  let template: Template;
  try {
    // The files as the operator serves them for this id: its placeholder
    // replaced by the operator, not by this editor.
    template = await readTemplate(client, templateId, defaultFunctionId(name));
  } catch (err) {
    ui.error(
      start === "blank"
        ? `Airdress: ${targetPhrase(profile)} does not serve a "${BLANK_TEMPLATE_ID}" template yet — start from a template instead. (${
            err instanceof Error ? err.message : String(err)
          })`
        : `Airdress: reading template ${templateId} failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
    );
    return undefined;
  }

  const where = await ui.pick(
    [
      {
        label: SCRATCH_FOLDER,
        detail: "Kept by the editor, outside any repository.",
      },
      {
        label: WORKSPACE_FOLDER,
        detail: "A folder you choose, e.g. inside a git checkout.",
      },
    ],
    `Where should ${name}'s files go?`,
  );
  if (!where) {
    return undefined;
  }
  let root: vscode.Uri | undefined;
  if (where.label === SCRATCH_FOLDER) {
    root = await freeFolder(deps.scratchRoot(profile), name);
  } else {
    const ws = deps.workspaceRoot();
    root = await ui.pickFolder(ws ? vscode.Uri.joinPath(ws, name) : undefined);
  }
  if (!root) {
    return undefined;
  }
  for (const occupied of [MANIFEST_FILE, CHECKOUT_FILE, OWNER_MANIFEST_FILE]) {
    if (await exists(vscode.Uri.joinPath(root, occupied))) {
      ui.error(
        `Airdress: ${root.fsPath} already holds ${occupied}. Pick an empty folder.`,
      );
      return undefined;
    }
  }

  const values = await askConfig(ui, template.config.fields);
  if (!values) {
    return undefined;
  }
  const config = configEntries(template.config.fields, values);
  if (config.missing.length > 0 || config.invalid.length > 0) {
    ui.error(
      `Airdress: ${[
        config.missing.length ? `Required: ${config.missing.join(", ")}.` : "",
        ...config.invalid,
      ]
        .filter(Boolean)
        .join(" ")}`,
    );
    return undefined;
  }

  const files = forkFiles(template.files);
  for (const f of files) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, ...f.path.split("/")),
      Buffer.from(f.content, "utf8"),
    );
  }
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(root, OWNER_MANIFEST_FILE),
    Buffer.from(
      ownerManifestDraft({
        name,
        requires: template.requires,
        config: config.entries,
      }),
      "utf8",
    ),
  );
  const checkout: Checkout = {
    root,
    record: {
      operator: profile.fqdn,
      function: name,
      basedOn: null,
      template: template.id,
    },
  };
  await writeCheckout(root, checkout.record);
  await ui.open(
    vscode.Uri.joinPath(root, ...(template.entry || MANIFEST_FILE).split("/")),
  );
  const choice = await ui.info(
    `Airdress: ${name} is ready to edit in ${root.fsPath}. Deploy creates it on ${profile.label}, after showing what it will be allowed to do.`,
    DEPLOY_NOW,
  );
  if (choice === DEPLOY_NOW) {
    await deps.deploy(checkout);
  }
  return checkout;
}
