import { deriveSpecFields, readAt, writeAt, type FormField } from "../form";
import {
  functionRoute,
  type ResourceStatus,
  type HostMessage,
  type InvocationResult,
  type ManifestObject,
  type PanelDiagnostic,
  type PanelMessage,
} from "../protocol";

/**
 * The resource configuration panel — browser side. Plain DOM, no
 * framework: the form is drawn from the schema fields the extension
 * sends, grouped into the sections a person expects, and every edit
 * updates one manifest object that the buttons post back whole.
 *
 * Layout and colour live in media/function-panel.css (VS Code theme
 * variables only); this file assigns class names and nothing else
 * visual, so a restyle is a one-file change.
 */

declare function acquireVsCodeApi(): {
  postMessage(message: PanelMessage): void;
  getState(): { manifest?: ManifestObject } | undefined;
  setState(state: { manifest?: ManifestObject }): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;

interface View {
  mode: "existing" | "new";
  /** The Kind this panel edits — every heading and confirm names it. */
  kind: string;
  manifest: ManifestObject;
  status?: ResourceStatus;
  fields: FormField[];
  /**
   * True when no schema was published for this Kind, so `spec` is edited
   * as raw YAML. The floor, not a degraded mode (FR-2).
   */
  yamlMode: boolean;
  profile: { label: string; fqdn: string };
  loadError?: string;
}

/** Kinds carrying the invoke/bundle affordances (design §2.1). */
function hasFunctionExtras(kind: string): boolean {
  return kind === "Function";
}

let view: View | undefined;
let diagnostics: PanelDiagnostic[] = [];
let validateTimer: ReturnType<typeof setTimeout> | undefined;

/** Which section each top-level `spec` group is drawn in. */
const SECTION_OF: Record<string, string> = {
  bundle: "Bundle",
  runtime: "Bundle",
  capabilities: "Permissions",
  limits: "Limits",
  enabled: "Overview",
};
const SECTION_ORDER = [
  "Overview",
  "Bundle",
  "Permissions",
  "Limits",
  "Other",
  "Trigger",
  "Danger",
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function spec(): Record<string, unknown> {
  if (!view) {
    return {};
  }
  if (typeof view.manifest.spec !== "object" || view.manifest.spec === null) {
    view.manifest.spec = {};
  }
  return view.manifest.spec as Record<string, unknown>;
}

function name(): string {
  const metadata = view?.manifest.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const n = (metadata as Record<string, unknown>).name;
    return typeof n === "string" ? n : "";
  }
  return "";
}

function post(message: PanelMessage): void {
  vscode.postMessage(message);
}

function scheduleValidate(): void {
  if (!view) {
    return;
  }
  vscode.setState({ manifest: view.manifest });
  clearTimeout(validateTimer);
  validateTimer = setTimeout(() => {
    if (view) {
      post({ type: "validate", manifest: view.manifest });
    }
  }, 250);
}

function pointer(path: string[]): string {
  return `/spec/${path.join("/")}`;
}

function diagnosticsAt(pointerPath: string): PanelDiagnostic[] {
  return diagnostics.filter(
    (d) => d.path === pointerPath || d.path.startsWith(`${pointerPath}/`),
  );
}

// ---------- field controls ----------

function control(field: FormField): HTMLElement {
  const wrap = el("div", "field");
  wrap.dataset.path = pointer(field.path);
  const label = el("label", "field-label", field.label);
  if (field.required) {
    label.append(el("span", "field-required", " required"));
  }
  wrap.append(label);
  const current = readAt(spec(), field.path);

  switch (field.kind) {
    case "boolean": {
      const input = el("input");
      input.type = "checkbox";
      input.checked =
        current === undefined ? field.default === true : current === true;
      input.addEventListener("change", () => {
        writeAt(spec(), field.path, input.checked);
        scheduleValidate();
      });
      label.prepend(input);
      break;
    }
    case "enum": {
      const select = el("select");
      for (const option of field.enum ?? []) {
        const opt = el("option", undefined, option);
        opt.value = option;
        select.append(opt);
      }
      select.value = String(current ?? field.default ?? field.enum?.[0] ?? "");
      select.addEventListener("change", () => {
        writeAt(spec(), field.path, select.value);
        scheduleValidate();
      });
      wrap.append(select);
      break;
    }
    case "integer":
    case "number": {
      const input = el("input");
      input.type = "number";
      if (field.minimum !== undefined) {
        input.min = String(field.minimum);
      }
      if (field.maximum !== undefined) {
        input.max = String(field.maximum);
      }
      if (field.kind === "integer") {
        input.step = "1";
      }
      input.placeholder =
        field.default !== undefined ? `default ${String(field.default)}` : "";
      input.value = typeof current === "number" ? String(current) : "";
      input.addEventListener("input", () => {
        const v = input.value.trim();
        writeAt(spec(), field.path, v === "" ? undefined : Number(v));
        scheduleValidate();
      });
      wrap.append(input);
      break;
    }
    case "string-list": {
      const list = el("ul", "string-list");
      const items = Array.isArray(current) ? current.map(String) : [];
      const render = () => {
        list.replaceChildren();
        items.forEach((item, i) => {
          const li = el("li");
          li.append(el("code", undefined, item));
          const remove = el("button", "small", "Remove");
          remove.type = "button";
          remove.addEventListener("click", () => {
            items.splice(i, 1);
            writeAt(spec(), field.path, items.length ? [...items] : undefined);
            render();
            scheduleValidate();
          });
          li.append(remove);
          list.append(li);
        });
      };
      render();
      const row = el("div", "string-list-add");
      const input = el("input");
      input.type = "text";
      input.placeholder = "op2.a.airdr.es";
      const add = el("button", "small", "Add");
      add.type = "button";
      const commit = () => {
        const v = input.value.trim();
        if (!v) {
          return;
        }
        items.push(v);
        input.value = "";
        writeAt(spec(), field.path, [...items]);
        render();
        scheduleValidate();
      };
      add.addEventListener("click", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      });
      row.append(input, add);
      wrap.append(list, row);
      break;
    }
    case "opaque": {
      const note = el(
        "p",
        "field-unavailable",
        "not yet available on this operator",
      );
      const input = el("input");
      input.type = "text";
      input.disabled = true;
      input.value = current === undefined ? "" : JSON.stringify(current);
      wrap.append(input, note);
      wrap.classList.add("field-disabled");
      break;
    }
    default: {
      const input = el("input");
      input.type = "text";
      if (field.pattern) {
        input.pattern = field.pattern;
      }
      input.placeholder = field.nullable ? "unset" : "";
      input.value = typeof current === "string" ? current : "";
      input.addEventListener("input", () => {
        const v = input.value;
        writeAt(spec(), field.path, v === "" ? undefined : v);
        scheduleValidate();
      });
      wrap.append(input);
    }
  }
  if (field.description) {
    wrap.append(el("p", "field-help", field.description));
  }
  wrap.append(el("div", "field-diagnostics"));
  return wrap;
}

// ---------- sections ----------

function overview(v: View): HTMLElement {
  const section = el("section", "section section-overview");
  section.append(el("h2", undefined, "Overview"));

  const nameRow = el("div", "field");
  nameRow.dataset.path = "/metadata/name";
  const nameLabel = el("label", "field-label", "Name");
  nameLabel.append(el("span", "field-required", " required"));
  const nameInput = el("input");
  nameInput.type = "text";
  nameInput.value = name();
  nameInput.disabled = v.mode === "existing";
  nameInput.addEventListener("input", () => {
    (v.manifest.metadata as Record<string, unknown>).name = nameInput.value;
    routeValue.textContent = functionRoute(nameInput.value || "<name>");
    scheduleValidate();
  });
  nameRow.append(nameLabel, nameInput, el("div", "field-diagnostics"));
  section.append(nameRow);

  const routeRow = el("div", "field");
  routeRow.append(el("span", "field-label", "Route"));
  const routeValue = el(
    "code",
    "route",
    v.status?.route ?? functionRoute(name() || "<name>"),
  );
  routeRow.append(routeValue);
  section.append(routeRow);

  const target = el("div", "field");
  target.append(el("span", "field-label", "Operator"));
  target.append(
    el("span", undefined, `${v.profile.label} (${v.profile.fqdn})`),
  );
  section.append(target);

  if (v.loadError) {
    section.append(el("p", "notice notice-error", v.loadError));
  }

  if (v.mode === "existing") {
    const status = v.status;
    const phaseRow = el("div", "field");
    phaseRow.append(el("span", "field-label", "Phase"));
    const phase = status?.phase ?? "Unknown";
    phaseRow.append(el("span", `phase phase-${phase.toLowerCase()}`, phase));
    section.append(phaseRow);

    const table = el("table", "conditions");
    const head = el("tr");
    for (const h of ["Condition", "Status", "Reason", "Message"]) {
      head.append(el("th", undefined, h));
    }
    table.append(head);
    for (const c of status?.conditions ?? []) {
      const tr = el("tr", `condition-${c.status.toLowerCase()}`);
      tr.append(
        el("td", undefined, c.type),
        el("td", undefined, c.status),
        el("td", undefined, c.reason ?? ""),
        el("td", undefined, c.message ?? ""),
      );
      table.append(tr);
    }
    if (!status || status.conditions.length === 0) {
      const tr = el("tr");
      const td = el("td", "muted", "No conditions reported.");
      td.colSpan = 4;
      tr.append(td);
      table.append(tr);
    }
    section.append(table);

    const facts = el("dl", "facts");
    const fact = (k: string, val: string | undefined) => {
      if (val) {
        facts.append(el("dt", undefined, k), el("dd", undefined, val));
      }
    };
    if (hasFunctionExtras(v.kind)) {
      fact("Loaded bundle sha256", status?.bundleSha256);
      fact("Function id", status?.functionId);
    }
    fact("Loaded at", status?.loadedAt);
    fact("Last error", status?.lastError);
    section.append(facts);
  }
  return section;
}

function trigger(v: View): HTMLElement {
  const section = el("section", "section section-trigger");
  section.append(el("h2", undefined, "Trigger"));
  const p = el("p");
  p.append(
    "HTTP, ",
    el("code", undefined, `POST ${functionRoute(name() || "<name>")}`),
    " — the only trigger in this version, fixed by the name.",
  );
  section.append(p);

  const box = el("div", "invoke");
  const body = el("textarea");
  body.rows = 5;
  body.placeholder = '{"hello": "world"}';
  body.disabled = v.mode === "new";
  const button = el("button", "primary", "Test invoke");
  button.type = "button";
  button.disabled = v.mode === "new";
  const result = el("pre", "invoke-result");
  result.hidden = true;
  button.addEventListener("click", () => {
    result.hidden = false;
    result.textContent = "…";
    post({ type: "invoke", body: body.value });
  });
  box.append(body, button, result);
  if (v.mode === "new") {
    box.append(
      el(
        "p",
        "field-help",
        `Apply the ${v.kind.toLowerCase()} first; then it can be invoked.`,
      ),
    );
  }
  section.append(box);
  return section;
}

function danger(v: View): HTMLElement {
  const section = el("section", "section section-danger");
  section.append(el("h2", undefined, "Danger"));
  const row = el("div", "actions");
  const disable = el("button", "danger", "Disable");
  disable.type = "button";
  disable.title =
    "Sets enabled: false and applies — the route stops answering, the manifest stays.";
  disable.disabled = v.mode === "new";
  disable.addEventListener("click", () =>
    post({ type: "disable", manifest: v.manifest }),
  );
  const remove = el("button", "danger", "Delete…");
  remove.type = "button";
  remove.title = `Removes the ${v.kind} from the operator after a confirmation.`;
  remove.disabled = v.mode === "new";
  remove.addEventListener("click", () => post({ type: "delete" }));
  row.append(disable, remove);
  section.append(row);
  return section;
}

function actions(v: View): HTMLElement {
  const bar = el("div", "actions actions-main");
  const diff = el("button", undefined, "Diff against live");
  diff.type = "button";
  diff.addEventListener("click", () =>
    post({ type: "diff", manifest: v.manifest }),
  );
  const apply = el("button", "primary", "Apply…");
  apply.type = "button";
  apply.title =
    "Validates, then confirms the profile and FQDN before applying.";
  apply.addEventListener("click", () =>
    post({ type: "apply", manifest: v.manifest }),
  );
  const reload = el("button", undefined, "Reload");
  reload.type = "button";
  reload.addEventListener("click", () => post({ type: "load" }));
  bar.append(diff, apply, reload);
  return bar;
}

/**
 * Minimal YAML for the spec editor.
 *
 * The webview is deliberately dependency-free plain DOM, so it does not
 * pull in the `yaml` package for one textarea. `spec` is a JSON value,
 * and YAML is a JSON superset, so round-tripping through JSON with
 * two-space indentation is honest and reversible. A Kind whose spec
 * needs anchors or multi-line scalars is a Kind that should publish a
 * schema and get a real form.
 */
function specToYaml(spec: unknown): string {
  if (spec === undefined || spec === null) {
    return "";
  }
  return JSON.stringify(spec, null, 2);
}

/** Parse the editor's text, or undefined when it is not valid. */
function yamlToSpec(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Raw-YAML editor for `spec`, used when the operator has published no
 * schema for this Kind. Edits land on the same manifest object the
 * buttons post, so apply/diff/delete are identical to form mode; only
 * the editing affordance differs (design §2.2).
 */
function specYaml(v: View): HTMLElement {
  const section = el("section", "section section-spec");
  section.append(el("h2", undefined, "Spec"));
  section.append(
    el(
      "p",
      "field-help",
      `No published schema for ${v.kind} — edit spec as YAML. ` +
        "Validation is disabled, so the operator is the first thing that " +
        "will reject a mistake.",
    ),
  );
  const box = el("textarea", "spec-yaml");
  box.rows = 16;
  box.spellcheck = false;
  box.value = specToYaml(v.manifest.spec);
  box.addEventListener("input", () => {
    const parsed = yamlToSpec(box.value);
    box.classList.toggle("field-invalid", parsed === undefined);
    if (parsed !== undefined) {
      v.manifest.spec = parsed;
    }
  });
  section.append(box);
  return section;
}

function render(): void {
  if (!view) {
    return;
  }
  const v = view;
  app.replaceChildren();

  const header = el("header", "header");
  header.append(
    el(
      "h1",
      undefined,
      v.mode === "new" ? `New ${v.kind}` : `${v.kind}: ${name()}`,
    ),
    el("div", "busy", ""),
  );
  app.append(header);
  app.append(el("div", "notices"));

  const sections = new Map<string, HTMLElement>();
  const sectionFor = (title: string) => {
    let s = sections.get(title);
    if (!s) {
      s = el("section", `section section-${title.toLowerCase()}`);
      s.append(el("h2", undefined, title));
      sections.set(title, s);
    }
    return s;
  };
  sections.set("Overview", overview(v));
  if (v.yamlMode) {
    sections.set("Spec", specYaml(v));
  }
  for (const field of v.fields) {
    sectionFor(SECTION_OF[field.group] ?? "Other").append(control(field));
  }
  if (hasFunctionExtras(v.kind)) {
    sections.set("Trigger", trigger(v));
  }
  sections.set("Danger", danger(v));
  for (const title of SECTION_ORDER) {
    const s = sections.get(title);
    if (s) {
      app.append(s);
    }
  }
  app.append(el("div", "diagnostics"));
  app.append(actions(v));
  paintDiagnostics();
}

function paintDiagnostics(): void {
  for (const node of app.querySelectorAll<HTMLElement>(".field")) {
    const box = node.querySelector(".field-diagnostics");
    if (!box) {
      continue;
    }
    box.replaceChildren();
    const own = node.dataset.path ? diagnosticsAt(node.dataset.path) : [];
    node.classList.toggle("field-invalid", own.length > 0);
    for (const d of own) {
      box.append(el("p", "diagnostic", d.message));
    }
  }
  const summary = app.querySelector(".diagnostics");
  if (summary) {
    summary.replaceChildren();
    if (diagnostics.length === 0) {
      summary.append(
        el(
          "p",
          "diagnostic-ok",
          view?.yamlMode
            ? "No schema published for this kind — not validated here."
            : "Valid against the bundled schema.",
        ),
      );
    } else {
      for (const d of diagnostics) {
        summary.append(el("p", "diagnostic", `${d.path}: ${d.message}`));
      }
    }
  }
}

function notice(level: "info" | "error", message: string): void {
  const box = app.querySelector(".notices");
  if (!box) {
    return;
  }
  const p = el("p", `notice notice-${level}`, message);
  box.append(p);
  setTimeout(() => p.remove(), 8000);
}

function showInvocation(result: InvocationResult): void {
  const pre = app.querySelector<HTMLElement>(".invoke-result");
  if (!pre) {
    return;
  }
  pre.hidden = false;
  pre.textContent = result.error
    ? `no answer after ${result.durationMs} ms — ${result.error}`
    : `HTTP ${result.status ?? "?"} in ${result.durationMs} ms\n\n${result.body ?? ""}`;
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state": {
      const draft = vscode.getState()?.manifest;
      // A hidden-and-re-shown panel gets fresh state from the operator;
      // an unsaved draft of a NEW function survives instead.
      const manifest =
        message.mode === "new" && draft ? draft : message.manifest;
      view = {
        mode: message.mode,
        manifest,
        status: message.status,
        kind: message.kind,
        fields: message.schema ? deriveSpecFields(message.schema) : [],
        yamlMode: !message.schema,
        profile: message.profile,
        loadError: message.loadError,
      };
      vscode.setState({ manifest });
      render();
      post({ type: "validate", manifest });
      return;
    }
    case "validation":
      diagnostics = message.diagnostics;
      paintDiagnostics();
      return;
    case "invocation":
      showInvocation(message.result);
      return;
    case "busy": {
      const busy = app.querySelector<HTMLElement>(".busy");
      if (busy) {
        busy.textContent = message.what ? `${message.what}…` : "";
      }
      // Buttons are held back by a class, not re-rendered: a re-render
      // after every validation would steal focus from the field being
      // typed in.
      app.classList.toggle("is-busy", message.what !== undefined);
      return;
    }
    case "notice":
      notice(message.level, message.message);
      return;
    case "closed":
      app.replaceChildren(el("p", "muted", "This function was deleted."));
      return;
  }
});

post({ type: "load" });
