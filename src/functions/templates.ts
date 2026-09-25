import * as YAML from "yaml";
import type {
  FormValues,
  TemplateField,
  TemplateRequires,
} from "./templateTypes";

export type { FormValues };

/**
 * A template, turned into the documents a person applies.
 *
 * Pure functions, no editor and no network: the form's values become
 * `spec.config` entries; `requires` becomes a capabilities block that
 * is SHOWN and never written; forking is the template's files, as the
 * operator served them, and nothing else.
 *
 * Imports nothing from `vscode`, so the panel's browser bundle can use
 * the same wording.
 */

/** One `spec.config` entry: exactly one of `value` and `valueFrom`. */
export type ConfigEntry =
  | { readonly name: string; readonly value: unknown }
  | {
      readonly name: string;
      readonly valueFrom: { readonly secretRef: string };
    };

/** The config entries, and the required fields left empty. */
export interface ConfigResult {
  readonly entries: readonly ConfigEntry[];
  readonly missing: readonly string[];
  /** Fields whose value is not of their type, with the reason. */
  readonly invalid: readonly string[];
}

/**
 * The form's values as `spec.config`. An empty field is left out — the
 * function then sees its own default. A `secret` field holds the NAME of
 * a secret on the operator and becomes `valueFrom.secretRef`; there is
 * no path by which a secret field produces an inline `value`.
 */
export function configEntries(
  fields: readonly TemplateField[],
  values: FormValues,
): ConfigResult {
  const entries: ConfigEntry[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const field of fields) {
    const raw = values[field.name];
    const empty =
      raw === undefined || (typeof raw === "string" && raw.trim() === "");
    if (field.type === "boolean") {
      if (raw === undefined) {
        if (field.required) {
          missing.push(field.name);
        }
        continue;
      }
      entries.push({ name: field.name, value: raw === true || raw === "true" });
      continue;
    }
    if (empty) {
      if (field.required) {
        missing.push(field.name);
      }
      continue;
    }
    const text = String(raw).trim();
    switch (field.type) {
      case "secret":
        entries.push({ name: field.name, valueFrom: { secretRef: text } });
        break;
      case "number": {
        const n = Number(text);
        if (!Number.isFinite(n)) {
          invalid.push(`${field.name}: "${text}" is not a number`);
        } else {
          entries.push({ name: field.name, value: n });
        }
        break;
      }
      default:
        entries.push({ name: field.name, value: text });
    }
  }
  return { entries, missing, invalid };
}

/** The worlds `requires` names, in the order the operator lists them. */
export function requiredWorlds(requires: TemplateRequires): string[] {
  return (["http", "log", "kv", "inbox", "identity", "llm"] as const).filter(
    (w) => requires[w] !== undefined,
  );
}

/**
 * The `spec.capabilities` block a template needs, as YAML to add. The
 * hosts are left for the owner to name when `hostsRequired` says the
 * template cannot know them — an empty list reaches nothing, which is
 * the safe thing for a suggestion to say.
 */
export function capabilitiesSuggestion(requires: TemplateRequires): string {
  const worlds = requiredWorlds(requires);
  if (worlds.length === 0) {
    return "";
  }
  const lines = ["spec:", "  capabilities:"];
  for (const w of worlds) {
    switch (w) {
      case "http":
        lines.push("    http:");
        lines.push(
          requires.http?.hostsRequired
            ? "      hosts: [] # name every host it may reach; the template cannot know them"
            : "      hosts: []",
        );
        break;
      case "inbox":
        lines.push("    inbox:");
        lines.push("      topics: [] # the topics it may publish to");
        break;
      case "llm":
        lines.push("    llm:");
        lines.push("      providers: [] # the providers it may call");
        lines.push("      models: [] # and the models");
        break;
      default:
        lines.push(`    ${w}: {}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Why the form does not write the grant — said beside the YAML. */
export const GRANT_EXPLANATION =
  "The form does not write these grants. A grant is the owner's decision, " +
  "made by applying the Function manifest; the operator refuses a publish " +
  "that tries to carry one, so a form that wrote it would fail — and one " +
  "that slipped it into a manifest would decide for you. Read it, then add " +
  "it under spec in the manifest yourself.";

/**
 * Who may sign, as the manifest names it: always the set form. The
 * single forms (`signer`, `signerRef`) are still read, never written.
 */
export type SignerNaming =
  | {
      readonly signers: ReadonlyArray<
        { readonly key: string } | { readonly machine: string }
      >;
    }
  | Record<string, never>;

/**
 * The Function manifest a template's form produces: the source version,
 * the signer, the configuration — and no `spec.capabilities`. The grant
 * the template needs is carried as COMMENTED YAML above the document, so
 * applying the draft as it is grants nothing.
 */
export function manifestDraft(opts: {
  name: string;
  version: string;
  signer: SignerNaming;
  config: readonly ConfigEntry[];
  requires: TemplateRequires;
}): string {
  const manifest = {
    apiVersion: "airdress.co/v1alpha1",
    kind: "Function",
    metadata: { name: opts.name },
    spec: {
      runtime: "js-source/v1",
      source: { version: opts.version, ...opts.signer },
      ...(opts.config.length > 0 ? { config: opts.config } : {}),
      enabled: true,
    },
  };
  const suggestion = capabilitiesSuggestion(opts.requires);
  const header = suggestion
    ? [
        "# This function needs grants the form did not write.",
        ...wrap(GRANT_EXPLANATION, 72).map((l) => `#   ${l}`),
        "#",
        ...suggestion
          .trimEnd()
          .split("\n")
          .map((l) => `# ${l}`),
        "",
      ].join("\n")
    : "";
  return header + YAML.stringify(manifest);
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) {
    out.push(line);
  }
  return out;
}

/**
 * The files a fork writes: the template's tree, byte for byte, and
 * nothing else — no record of the template, no marker naming it. What is
 * left is ordinary source; the operator never consults the template for
 * a function made from it.
 */
export function forkFiles(
  files: Readonly<Record<string, string>>,
): Array<{ path: string; content: string }> {
  return Object.keys(files)
    .sort()
    .map((path) => {
      const parts = path.split("/");
      if (
        path.startsWith("/") ||
        parts.some((s) => s === ".." || s === "." || s === "")
      ) {
        // The operator's own archive rules refuse such a path; a template
        // carrying one is a defect to report, not a file to write.
        throw new Error(`the template names an unsafe path: ${path}`);
      }
      return { path, content: files[path] };
    });
}
