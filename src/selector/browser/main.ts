import type {
  SelectorAction,
  SelectorHostMessage,
  SelectorState,
} from "../protocol";

/**
 * The selector view, browser side. Renders one SelectorState; every
 * click posts one SelectorAction. No state of its own beyond the last
 * render — on re-show it asks for `load` and draws what comes back.
 */

declare function acquireVsCodeApi(): {
  postMessage(message: SelectorAction): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(
  label: string,
  action: SelectorAction,
  opts: { primary?: boolean; disabled?: boolean } = {},
): HTMLButtonElement {
  const b = el(
    "button",
    opts.primary ? "primary" : undefined,
    label,
  ) as HTMLButtonElement;
  b.disabled = opts.disabled ?? false;
  b.addEventListener("click", () => vscode.postMessage(action));
  return b;
}

function render(state: SelectorState): void {
  app.replaceChildren();
  const { active } = state;

  if (!active) {
    const empty = el("section", "empty");
    empty.append(
      el(
        "p",
        undefined,
        state.profiles.length === 0
          ? "No airdress connected yet."
          : "No airdress selected.",
      ),
    );
    const row = el("div", "actions");
    if (state.profiles.length > 0) {
      row.append(...switchButtons(state));
    }
    row.append(
      button("Connect an Airdress…", { type: "connect" }, { primary: true }),
    );
    empty.append(row);
    app.append(empty);
    return;
  }

  const head = el("section", "active");
  head.append(el("h2", undefined, active.label));
  head.append(el("code", "fqdn", active.fqdn));

  const facts = el("dl", "facts");
  facts.append(el("dt", undefined, "Reach"));
  facts.append(
    el(
      "dd",
      `reach reach-${active.reach}`,
      active.reach === "reachable"
        ? `reachable${active.latencyMs !== undefined ? ` · ${active.latencyMs} ms` : ""}`
        : active.reach === "unreachable"
          ? "unreachable"
          : "not observed yet",
    ),
  );
  facts.append(el("dt", undefined, "Credential"));
  facts.append(
    el(
      "dd",
      `credential credential-${active.credential}`,
      active.credential === "signed-in"
        ? active.authMode === "bearer"
          ? "bearer token"
          : "signed in"
        : active.credential === "needs-sign-in"
          ? "needs sign-in"
          : "not checked yet",
    ),
  );
  head.append(facts);

  const actions = el("div", "actions");
  if (active.credential === "needs-sign-in") {
    actions.append(
      button(
        "Sign in again",
        { type: "signInAgain" },
        { primary: true, disabled: state.busy },
      ),
    );
  }
  actions.append(...switchButtons(state));
  actions.append(
    button("Refresh", { type: "refresh" }, { disabled: state.busy }),
  );
  actions.append(button("Connect another…", { type: "connect" }));
  head.append(actions);
  if (state.busy) {
    head.append(el("p", "busy", "Working…"));
  }
  app.append(head);
}

/** One button per OTHER profile — switching is a click, not a pick. */
function switchButtons(state: SelectorState): HTMLElement[] {
  return state.profiles
    .filter((p) => p.id !== state.active?.id)
    .map((p) =>
      button(
        `Switch to ${p.label}`,
        { type: "switch", id: p.id },
        {
          disabled: state.busy,
        },
      ),
    );
}

window.addEventListener(
  "message",
  (event: MessageEvent<SelectorHostMessage>) => {
    if (event.data?.type === "state") {
      render(event.data.state);
    }
  },
);

vscode.postMessage({ type: "load" });
