import type { FormValues, TemplateSummary } from "./templateTypes";

/**
 * Messages between the template panel and the extension. Shared by both
 * bundles; imports nothing from `vscode` or Node.
 */

/** Extension → panel. */
export type TemplateHostMessage =
  | {
      readonly type: "template";
      readonly template: TemplateSummary;
      /** The capabilities YAML to add — shown, never written. */
      readonly grantYaml: string;
      readonly grantExplanation: string;
      readonly profile: { readonly label: string; readonly fqdn: string };
    }
  | { readonly type: "busy"; readonly busy: boolean }
  | { readonly type: "result"; readonly ok: boolean; readonly message: string };

/** Panel → extension. */
export type TemplatePanelMessage =
  | { readonly type: "ready" }
  | {
      readonly type: "create";
      readonly name: string;
      /** The id written into `function.json` in place of the placeholder. */
      readonly functionId: string;
      readonly values: FormValues;
    }
  | { readonly type: "fork"; readonly functionId: string }
  | { readonly type: "copyGrant" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a message from the webview. The panel is ours, but its
 * messages cross a boundary, and a malformed one is dropped rather than
 * half-acted on.
 */
export function parseTemplatePanelMessage(
  v: unknown,
): TemplatePanelMessage | undefined {
  if (!isRecord(v) || typeof v.type !== "string") {
    return undefined;
  }
  switch (v.type) {
    case "ready":
    case "copyGrant":
      return { type: v.type };
    case "fork":
      return typeof v.functionId === "string"
        ? { type: "fork", functionId: v.functionId }
        : undefined;
    case "create": {
      if (
        typeof v.name !== "string" ||
        typeof v.functionId !== "string" ||
        !isRecord(v.values)
      ) {
        return undefined;
      }
      const values: Record<string, string | boolean> = {};
      for (const [k, val] of Object.entries(v.values)) {
        if (typeof val === "string" || typeof val === "boolean") {
          values[k] = val;
        }
      }
      return {
        type: "create",
        name: v.name,
        functionId: v.functionId,
        values,
      };
    }
    default:
      return undefined;
  }
}

/** The pattern the operator's `function.json` schema holds `id` to. */
export const FUNCTION_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * The function id offered before the author types one. `function.json`'s
 * `id` is reverse-DNS — at least two dot-joined lowercase labels — so a
 * name that already is one is kept, and any other becomes
 * `local.<slug>`: lowercased, every run of other characters one dash,
 * dashes trimmed, `fn-` in front of a slug that does not start with a
 * letter. The CLI's `fn new` derives the same id from a folder name. The
 * author can change it; the operator is the one that validates it.
 */
export function defaultFunctionId(name: string): string {
  const lower = name.trim().toLowerCase();
  if (FUNCTION_ID_PATTERN.test(lower) && lower.length <= 255) {
    return lower;
  }
  let slug = lower
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") {
    slug = "function";
  } else if (!/^[a-z]/.test(slug)) {
    slug = `fn-${slug}`;
  }
  return `local.${slug}`.slice(0, 255).replace(/-+$/, "");
}
