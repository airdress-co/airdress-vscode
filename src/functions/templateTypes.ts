/**
 * The template document, as `GET /v1/functions/templates` serves it.
 * Types only, with no imports: shared by the extension and the template
 * panel's browser bundle.
 */

/** `requires` in a template: one optional entry per host world. */
export interface TemplateRequires {
  readonly http?: { readonly hostsRequired: boolean };
  readonly log?: Record<string, never>;
  readonly kv?: Record<string, never>;
  readonly inbox?: Record<string, never>;
  readonly identity?: Record<string, never>;
  readonly llm?: Record<string, never>;
}

/** One field of a template's configuration form. */
export interface TemplateField {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "secret";
  readonly required?: boolean;
  readonly default?: unknown;
  readonly description: string;
}

/** A catalogue entry: `template.json`. */
export interface TemplateSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly entry: string;
  readonly requires: TemplateRequires;
  readonly config: { readonly fields: readonly TemplateField[] };
}

/** One template with its files: archive path → text. */
export interface Template extends TemplateSummary {
  readonly files: Readonly<Record<string, string>>;
}

/** What the form collected, keyed by field name. */
export type FormValues = Readonly<Record<string, string | boolean | undefined>>;
