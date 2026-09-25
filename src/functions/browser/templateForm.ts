import {
  defaultFunctionId,
  type TemplateHostMessage,
  type TemplatePanelMessage,
} from "../templateProtocol";
import type { TemplateField, TemplateSummary } from "../templateTypes";

/**
 * The template panel — browser side. Plain DOM, text set through
 * `textContent` only: everything drawn here came from an operator.
 *
 * The form collects values and posts them; turning them into
 * `spec.config` happens in the extension, in one tested function. The
 * grant is drawn as read-only text with a copy button and the reason it
 * is not written.
 */

declare function acquireVsCodeApi(): {
  postMessage(message: TemplatePanelMessage): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) {
    node.className = props.className;
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  node.append(...children);
  return node;
}

const inputs = new Map<string, HTMLInputElement>();
let nameInput: HTMLInputElement | undefined;
let idInput: HTMLInputElement | undefined;
let resultLine: HTMLElement | undefined;
let buttons: HTMLButtonElement[] = [];

function fieldRow(field: TemplateField): HTMLElement {
  const id = `field-${field.name}`;
  const input = document.createElement("input");
  input.id = id;
  const label = el("label", {
    text: field.type === "secret" ? `${field.name} — secret name` : field.name,
  });
  label.htmlFor = id;
  if (field.type === "boolean") {
    input.type = "checkbox";
    input.checked = field.default === true;
  } else {
    input.type = field.type === "number" ? "number" : "text";
    if (field.type !== "secret" && field.default !== undefined) {
      input.placeholder = `default: ${String(field.default)}`;
    }
    if (field.type === "secret") {
      input.placeholder = "the name of a secret this operator holds";
      input.autocomplete = "off";
      input.spellcheck = false;
    }
  }
  inputs.set(field.name, input);
  const notes = [field.description];
  if (field.type === "secret") {
    notes.push(
      "Written as valueFrom.secretRef: the value is read from that secret at each call and never appears in the manifest.",
    );
  }
  if (field.required) {
    notes.push("Required.");
  }
  return el(
    "div",
    { className: "field" },
    label,
    input,
    el("p", { className: "hint", text: notes.join(" ") }),
  );
}

function values(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [name, input] of inputs) {
    out[name] = input.type === "checkbox" ? input.checked : input.value;
  }
  return out;
}

function render(
  template: TemplateSummary,
  grantYaml: string,
  grantExplanation: string,
  profile: { label: string; fqdn: string },
): void {
  inputs.clear();
  app.replaceChildren();
  app.append(
    el("h1", { text: template.title }),
    el("p", {
      className: "muted",
      text: `${template.id} · ${profile.label} (${profile.fqdn})`,
    }),
    el("p", { text: template.description }),
  );

  const grant = el("section", { className: "section" });
  grant.append(el("h2", { text: "Grants it needs" }));
  if (grantYaml) {
    const copy = el("button", { text: "Copy YAML" });
    copy.addEventListener("click", () =>
      vscode.postMessage({ type: "copyGrant" }),
    );
    grant.append(
      el("p", {
        text: "This needs these grants. Here is the YAML to add to the Function manifest:",
      }),
      el("pre", { className: "yaml", text: grantYaml }),
      copy,
      el("p", { className: "hint", text: grantExplanation }),
    );
  } else {
    grant.append(
      el("p", { text: "None — it runs with no capabilities granted." }),
    );
  }
  app.append(grant);

  const form = el("section", { className: "section" });
  form.append(el("h2", { text: "Configuration" }));
  nameInput = document.createElement("input");
  nameInput.id = "function-name";
  nameInput.type = "text";
  nameInput.value = template.id;
  nameInput.spellcheck = false;
  const nameLabel = el("label", { text: "Function name (metadata.name)" });
  nameLabel.htmlFor = nameInput.id;
  form.append(
    el(
      "div",
      { className: "field" },
      nameLabel,
      nameInput,
      el("p", { className: "hint", text: "Also its route: /fn/<name>." }),
    ),
  );
  idInput = document.createElement("input");
  idInput.id = "function-id";
  idInput.type = "text";
  idInput.value = defaultFunctionId(nameInput.value);
  idInput.spellcheck = false;
  // The id follows the name until the author edits it.
  let idEdited = false;
  idInput.addEventListener("input", () => {
    idEdited = true;
  });
  nameInput.addEventListener("input", () => {
    if (!idEdited && idInput && nameInput) {
      idInput.value = defaultFunctionId(nameInput.value);
    }
  });
  const idLabel = el("label", { text: "Function id (function.json id)" });
  idLabel.htmlFor = idInput.id;
  form.append(
    el(
      "div",
      { className: "field" },
      idLabel,
      idInput,
      el("p", {
        className: "hint",
        text: "The operator writes it into function.json in place of the template's placeholder.",
      }),
    ),
  );
  if (template.config.fields.length === 0) {
    form.append(el("p", { text: "This template takes no configuration." }));
  }
  for (const field of template.config.fields) {
    form.append(fieldRow(field));
  }
  app.append(form);

  const create = el("button", { text: "Publish and Draft Manifest" });
  create.addEventListener("click", () =>
    vscode.postMessage({
      type: "create",
      name: nameInput?.value ?? "",
      functionId: idInput?.value ?? "",
      values: values(),
    }),
  );
  const fork = el("button", {
    className: "secondary",
    text: "Fork the Code into a Folder…",
  });
  fork.addEventListener("click", () =>
    vscode.postMessage({ type: "fork", functionId: idInput?.value ?? "" }),
  );
  buttons = [create, fork];
  resultLine = el("p", { className: "result" });
  app.append(
    el(
      "section",
      { className: "section" },
      el("div", { className: "actions" }, create, fork),
      el("p", {
        className: "hint",
        text: "Publishing stores the template's code as a version and opens a manifest draft to review and apply. Forking copies the code into a folder as ordinary source, with no link back to the template.",
      }),
      resultLine,
    ),
  );
}

window.addEventListener(
  "message",
  (event: MessageEvent<TemplateHostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "template":
        render(msg.template, msg.grantYaml, msg.grantExplanation, msg.profile);
        break;
      case "busy":
        for (const b of buttons) {
          b.disabled = msg.busy;
        }
        break;
      case "result":
        if (resultLine) {
          resultLine.textContent = msg.message;
          resultLine.className = msg.ok ? "result ok" : "result error";
        }
        break;
    }
  },
);

vscode.postMessage({ type: "ready" });
