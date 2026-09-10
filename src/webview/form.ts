/**
 * Schema-to-form derivation for the Function configuration panel.
 *
 * The form is RENDERED FROM THE BUNDLED JSON SCHEMA: `spec`'s
 * properties are walked into a list of fields, and the browser side
 * draws whatever comes out. When the operator's next release moves the
 * schema (a new limit, a capability world that goes live, a renamed
 * key), the form moves with it instead of drawing a control for a
 * field the operator no longer has. Pure and framework-free, so both
 * bundles share it and a unit test can pin it.
 */

export type FormFieldKind =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "string-list"
  /** An object the schema describes only as "an object": not editable here. */
  | "opaque";

export interface FormField {
  /** Path under `spec`, e.g. ["bundle", "path"]. */
  path: string[];
  /** Top-level `spec` property this field belongs to. */
  group: string;
  kind: FormFieldKind;
  label: string;
  description?: string;
  required: boolean;
  /** Whether the schema lets this field be `null` (rendered as "unset"). */
  nullable: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  enum?: string[];
  default?: unknown;
}

type Schema = Record<string, unknown>;

function isRecord(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The schema's `type`, normalised to a set; `null` tracked separately. */
function typesOf(schema: Schema): { types: Set<string>; nullable: boolean } {
  const raw = schema.type;
  const list = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  const types = new Set(list.filter((t) => t !== "null"));
  return { types, nullable: list.includes("null") };
}

/** "cpuDeadlineMs" -> "Cpu deadline ms"; "sha256" -> "Sha256". */
export function labelFor(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldKind(schema: Schema, types: Set<string>): FormFieldKind {
  if (Array.isArray(schema.enum)) {
    return "enum";
  }
  if (types.has("boolean")) {
    return "boolean";
  }
  if (types.has("integer")) {
    return "integer";
  }
  if (types.has("number")) {
    return "number";
  }
  if (types.has("array")) {
    const items = isRecord(schema.items) ? schema.items : {};
    return typesOf(items).types.has("string") ? "string-list" : "opaque";
  }
  if (types.has("string")) {
    return "string";
  }
  return "opaque";
}

function walk(
  schema: Schema,
  path: string[],
  group: string,
  required: boolean,
  out: FormField[],
): void {
  const { types, nullable } = typesOf(schema);
  const properties = isRecord(schema.properties)
    ? schema.properties
    : undefined;
  if (types.has("object") && properties) {
    const requiredKeys = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((k): k is string => typeof k === "string")
        : [],
    );
    for (const key of Object.keys(properties)) {
      const child = properties[key];
      if (!isRecord(child)) {
        continue;
      }
      walk(
        child,
        [...path, key],
        group,
        required && requiredKeys.has(key),
        out,
      );
    }
    return;
  }
  const kind = fieldKind(schema, types);
  const items = isRecord(schema.items) ? schema.items : undefined;
  const constraints = kind === "string-list" && items ? items : schema;
  const field: FormField = {
    path,
    group,
    kind,
    label: labelFor(path[path.length - 1] ?? group),
    description:
      typeof schema.description === "string" ? schema.description : undefined,
    required,
    nullable,
  };
  if (typeof constraints.minimum === "number") {
    field.minimum = constraints.minimum;
  }
  if (typeof constraints.maximum === "number") {
    field.maximum = constraints.maximum;
  }
  if (typeof constraints.minLength === "number") {
    field.minLength = constraints.minLength;
  }
  if (typeof constraints.pattern === "string") {
    field.pattern = constraints.pattern;
  }
  if (Array.isArray(schema.enum)) {
    field.enum = schema.enum.map((v) => String(v));
  }
  if (schema.default !== undefined) {
    field.default = schema.default;
  }
  out.push(field);
}

/**
 * Derive the editable fields of a manifest's `spec` from a bundled
 * per-kind schema. Objects with declared properties are flattened into
 * their leaves; an object the schema describes without properties is
 * an "opaque" field the form shows but does not edit. `required` is
 * transitive: a leaf is required only if every object above it is.
 */
export function deriveSpecFields(schema: Schema): FormField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const spec = isRecord(properties.spec) ? properties.spec : undefined;
  if (!spec) {
    return [];
  }
  const out: FormField[] = [];
  const specProps = isRecord(spec.properties) ? spec.properties : {};
  const requiredTop = new Set(
    Array.isArray(spec.required)
      ? spec.required.filter((k): k is string => typeof k === "string")
      : [],
  );
  for (const key of Object.keys(specProps)) {
    const child = specProps[key];
    if (isRecord(child)) {
      walk(child, [key], key, requiredTop.has(key), out);
    }
  }
  return out;
}

/** Read a field's value out of a `spec` object; undefined when absent. */
export function readAt(spec: unknown, path: string[]): unknown {
  let cur: unknown = spec;
  for (const key of path) {
    if (!isRecord(cur)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

/**
 * Write a value into a `spec` object at `path`, creating intermediate
 * objects. `undefined` DELETES the key (the manifest omits the field,
 * so the operator's default applies) and prunes objects left empty.
 */
export function writeAt(spec: Schema, path: string[], value: unknown): void {
  if (path.length === 0) {
    return;
  }
  const [head, ...rest] = path;
  if (rest.length === 0) {
    if (value === undefined) {
      delete spec[head];
    } else {
      spec[head] = value;
    }
    return;
  }
  const existing = spec[head];
  const child: Schema = isRecord(existing) ? existing : {};
  writeAt(child, rest, value);
  if (Object.keys(child).length === 0 && value === undefined) {
    delete spec[head];
  } else {
    spec[head] = child;
  }
}
