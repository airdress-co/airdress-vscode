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

/**
 * The function id offered before the author types one: the function's
 * name, cut to what the operator accepts for `functionId` (1 to 128
 * letters, digits, dots, hyphens or underscores). The author can change
 * it; the operator is the one that validates it.
 */
export function defaultFunctionId(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 128);
}
