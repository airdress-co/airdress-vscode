import * as vscode from "vscode";
import type { ApiClient } from "../api/client";
import { MANIFEST_FILE } from "./local";
import {
  readSdkCatalogue,
  readSdkFiles,
  type RefusalFix,
  type SdkCatalogue,
} from "./wire";

/**
 * The Airdress Functions SDK (`@airdress/functions`) in the editor.
 *
 * The library is compiled into the operator; its types come from the
 * operator too (`GET /v1/functions/sdk/{version}`), never from npm. A new
 * function gets the pinned version's `sdk.d.ts` under `.airdress/` and a
 * `tsconfig.json` that includes it — both beside `function.json`, never
 * under `src/`, so neither is ever published — and a `test/` folder for
 * local tests, which is not published either.
 */

/** Where the types for `version` are written, relative to the function. */
export function typesPath(version: string): string {
  return `.airdress/sdk-${version}.d.ts`;
}

/**
 * The `tsconfig.json` a new function gets. `sdk.d.ts` is a script that
 * declares one ambient module per library module and the `airdress`
 * global, so it only has to be included.
 */
export const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src", "test", ".airdress"],
  },
  null,
  2,
)}\n`;

/** What `test/` holds when it is made: a note on what goes there. */
export const TEST_README = `Tests for this function live here, beside src/, so they are never
published: a publish sends exactly function.json and src/.

Import the library's fake host to run a module without an operator:

  import { installFakeHost } from "@airdress/functions/testing";

It needs a local copy of the pinned library (\`airdress fn sdk pull\`).
`;

/** One file the scaffold writes, relative to the function's folder. */
export interface ScaffoldFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Pin `version` in a `function.json`, unless it pins one already (a
 * template's own pin is kept). Formatting is the operator's JSON with two
 * spaces; the key order is kept.
 */
export function pinned(manifestText: string, version: string): string {
  const m = JSON.parse(manifestText) as Record<string, unknown>;
  if (typeof m.sdk === "string") {
    return manifestText;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = v;
    // Beside the host requirement it rides with.
    if (k === "minHost") {
      out.sdk = version;
    }
  }
  if (!("sdk" in out)) {
    out.sdk = version;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The version a function should pin: the one it pins, or the newest. */
export function pinFor(
  manifestText: string,
  catalogue: SdkCatalogue,
): string | undefined {
  try {
    const m = JSON.parse(manifestText) as { sdk?: unknown };
    if (typeof m.sdk === "string") {
      return m.sdk;
    }
  } catch {
    return undefined;
  }
  return catalogue.newest;
}

/**
 * The files a new function gets for the library, from the operator: the
 * pinned `function.json`, the types, a `tsconfig.json` unless one exists,
 * and `test/`. Nothing when the operator predates the library (its
 * catalogue route is absent) or carries no current version.
 */
export async function sdkScaffold(
  client: ApiClient,
  manifestText: string,
  hasTsconfig: boolean,
): Promise<ScaffoldFile[]> {
  let catalogue: SdkCatalogue;
  try {
    catalogue = await readSdkCatalogue(client);
  } catch {
    return [];
  }
  const version = pinFor(manifestText, catalogue);
  if (!version) {
    return [];
  }
  let files: Record<string, string>;
  try {
    files = await readSdkFiles(client, version);
  } catch {
    return [];
  }
  const types = files["sdk.d.ts"];
  if (types === undefined) {
    return [];
  }
  return [
    { path: MANIFEST_FILE, content: pinned(manifestText, version) },
    { path: typesPath(version), content: types },
    ...(hasTsconfig ? [] : [{ path: "tsconfig.json", content: TSCONFIG }]),
    { path: "test/README.md", content: TEST_README },
  ];
}

/**
 * `function.json` with an operator's fix applied: capabilities added
 * (each once), keys set. Undefined when the text is not a JSON object.
 */
export function applyFix(
  manifestText: string,
  fix: RefusalFix,
): string | undefined {
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(manifestText);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    m = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const add = fix.add?.capabilities ?? [];
  if (add.length > 0) {
    const caps = Array.isArray(m.capabilities)
      ? [...(m.capabilities as unknown[])]
      : [];
    const has = new Set(
      caps
        .map((c) =>
          c && typeof c === "object" ? (c as { name?: unknown }).name : c,
        )
        .filter((n): n is string => typeof n === "string"),
    );
    for (const c of add) {
      if (!has.has(c.name)) {
        caps.push({ name: c.name });
        has.add(c.name);
      }
    }
    m.capabilities = caps;
  }
  for (const [k, v] of Object.entries(fix.set ?? {})) {
    if (v !== undefined && v !== null) {
      m[k] = v;
    }
  }
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** A sentence for the quick fix's title. */
export function fixTitle(fix: RefusalFix): string {
  const caps = fix.add?.capabilities?.map((c) => c.name) ?? [];
  const sets = Object.entries(fix.set ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`);
  const parts = [
    ...(caps.length ? [`request ${caps.join(", ")}`] : []),
    ...(sets.length ? [`set ${sets.join(", ")}`] : []),
  ];
  return `Airdress: in ${fix.file}, ${parts.join(" and ")}`;
}

/**
 * The fixes behind this editor's markers. A marker the Problems view hands
 * back to a code action is a copy, not the object that was set, so a fix
 * is found by where it points and what it says.
 */
const fixes = new Map<string, { fix: RefusalFix; manifest: vscode.Uri }>();

function fixKey(uri: vscode.Uri, d: vscode.Diagnostic): string {
  const code =
    typeof d.code === "object" && d.code !== null
      ? String(d.code.value)
      : String(d.code);
  return `${uri.toString()}#${d.range.start.line}:${d.range.start.character}#${code}#${d.message}`;
}

/** Remember the fix a marker offers. */
export function rememberFix(
  uri: vscode.Uri,
  d: vscode.Diagnostic,
  fix: RefusalFix,
  manifest: vscode.Uri,
): void {
  fixes.set(fixKey(uri, d), { fix, manifest });
}

/** The fix a marker offers, if it offers one. */
export function fixFor(
  uri: vscode.Uri,
  d: vscode.Diagnostic,
): { fix: RefusalFix; manifest: vscode.Uri } | undefined {
  return fixes.get(fixKey(uri, d));
}

/** Quick fixes for the operator's refusals: they edit `function.json`. */
export class SdkFixProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): Promise<vscode.CodeAction[]> {
    const out: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      const found = fixFor(document.uri, d);
      if (!found) {
        continue;
      }
      let text: string;
      try {
        text = Buffer.from(
          await vscode.workspace.fs.readFile(found.manifest),
        ).toString("utf8");
      } catch {
        continue;
      }
      const next = applyFix(text, found.fix);
      if (next === undefined || next === text) {
        continue;
      }
      const action = new vscode.CodeAction(
        fixTitle(found.fix),
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [d];
      action.isPreferred = true;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        found.manifest,
        new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0),
        next,
      );
      action.edit = edit;
      out.push(action);
    }
    return out;
  }
}
