import * as vscode from "vscode";
import type { AuthManager } from "../auth/manager";
import type { HealthPoller } from "../health/poller";
import type { Profile } from "../profiles/model";
import type { ProfileStore } from "../profiles/store";
import { cspNonce } from "../webview/panel";
import { SelectorController, type SelectorHost } from "./controller";
import type { Credential, Reach, SelectorState } from "./protocol";

/**
 * The selector view — extension side. A WebviewView at the top of the
 * Airdress container that always shows WHICH airdress is current, and
 * two facts about it as facts: reachability (the health poller) and
 * credential state (the auth manager's reported outcomes).
 *
 * The probe is what turns "unknown" into a fact before the first
 * command: one cheap owner-authenticated read (`GET /v1/kinds`) on
 * activation and on every switch, only while the view is visible.
 * Never a poll — the health poller already is one.
 */
export const SELECTOR_VIEW_ID = "airdress.selector";

export interface SelectorDeps {
  profiles: ProfileStore;
  auth: AuthManager;
  poller: HealthPoller;
  /** The probe: any authenticated read; throws on failure. */
  probe: (profile: Profile) => Promise<void>;
  extensionUri: vscode.Uri;
}

function credentialOf(deps: SelectorDeps, profile: Profile): Credential {
  switch (deps.auth.outcomeFor(profile.id)) {
    case "ok":
      return "signed-in";
    case "unauthorized":
    case "no-credential":
      return "needs-sign-in";
    default:
      return "unknown";
  }
}

function reachOf(
  deps: SelectorDeps,
  profile: Profile,
): { reach: Reach; latencyMs?: number } {
  const signal = deps.poller.livenessFor(profile.id);
  if (!signal) {
    return { reach: "unknown" };
  }
  return signal.signal === "reachable"
    ? { reach: "reachable", latencyMs: signal.latencyMs }
    : { reach: "unreachable" };
}

export class SelectorViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly controller: SelectorController;
  /** Profile ids probed since the view last became visible. */
  private probed = new Set<string>();

  constructor(private readonly deps: SelectorDeps) {
    const host: SelectorHost = {
      profiles: () =>
        deps.profiles.list().map((p) => ({
          id: p.id,
          label: p.label,
          fqdn: p.fqdn,
          authMode: p.authMode,
        })),
      activeId: () => deps.profiles.activeId(),
      reach: (id) => {
        const p = deps.profiles.get(id);
        return p ? reachOf(deps, p) : { reach: "unknown" };
      },
      credential: (id) => {
        const p = deps.profiles.get(id);
        return p ? credentialOf(deps, p) : "unknown";
      },
      activate: (id) => deps.profiles.setActive(id),
      signInAgain: async (id) => {
        await vscode.commands.executeCommand(
          "airdress.profiles.signInAgain",
          deps.profiles.get(id),
        );
      },
      connect: async () => {
        await vscode.commands.executeCommand("airdress.connectAirdress");
      },
      probe: (id) => this.probeOnce(id, true),
      post: (message) => void this.view?.webview.postMessage(message),
    };
    this.controller = new SelectorController(host);
  }

  /** The state the view shows — for the dev-mode read and tests. */
  state(): SelectorState {
    return this.controller.state();
  }

  /** Re-render from current facts (profiles, poller, auth changed). */
  refresh(): void {
    if (this.view?.visible) {
      this.controller.render();
    }
  }

  /** A switch: probe the new active once, then render. */
  onActiveChanged(): void {
    const id = this.deps.profiles.activeId();
    if (id && this.view?.visible) {
      void this.probeOnce(id, false);
    }
    this.refresh();
  }

  private async probeOnce(id: string, force: boolean): Promise<void> {
    if (!force && this.probed.has(id)) {
      return;
    }
    const profile = this.deps.profiles.get(id);
    if (!profile) {
      return;
    }
    this.probed.add(id);
    try {
      await this.deps.probe(profile);
      // A read that succeeded is the fact; the auth manager reported
      // `ok` on the way through getAccessToken.
    } catch {
      // A 401 was reported by the client; anything else (unreachable,
      // 5xx) is the poller's story, not the credential's.
    }
    this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.deps.extensionUri, "dist"),
        vscode.Uri.joinPath(this.deps.extensionUri, "media"),
      ],
    };
    view.webview.html = selectorHtml(
      view.webview,
      this.deps.extensionUri,
      cspNonce(),
    );
    view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.controller.handle(raw);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.probed = new Set();
        this.onActiveChanged();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.onActiveChanged();
  }
}

/** The view's shell: the resource panel's CSP, its own bundle + style. */
export function selectorHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "selector.js"),
  );
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "selector.css"),
  );
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${style.toString()}">`,
    "<title>Airdress</title>",
    "</head>",
    "<body>",
    '<main id="app" aria-live="polite">Loading…</main>',
    `<script nonce="${nonce}" src="${script.toString()}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
