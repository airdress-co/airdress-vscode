import * as vscode from "vscode";
import type { Profile } from "../profiles/model";
import { cspNonce } from "../webview/panel";
import {
  parseTemplatePanelMessage,
  type TemplateHostMessage,
} from "./templateProtocol";
import {
  createFromTemplate,
  forkTemplate,
  templateView,
  type TemplateDeps,
} from "./templateFlows";
import type { Template } from "./wire";

/** The panel's view type — one per template shown. */
export const TEMPLATE_PANEL_VIEW_TYPE = "airdress.functionTemplate";

/** The webview shell. Exported so a test can pin the CSP. */
export function templatePanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "templateForm.js"),
  );
  const styles = ["function-panel.css", "template-panel.css"].map((f) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f)),
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
    ...styles.map((s) => `<link rel="stylesheet" href="${s.toString()}">`),
    "<title>Function template</title>",
    "</head>",
    "<body>",
    '<main id="app" aria-live="polite">Loading…</main>',
    `<script nonce="${nonce}" src="${script.toString()}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Show one template: what it is, the grants it needs as YAML to add, its
 * configuration as a form, and the two ways out — publish it and draft a
 * manifest, or fork its code into a folder.
 */
export function openTemplatePanel(
  extensionUri: vscode.Uri,
  deps: TemplateDeps,
  profile: Profile,
  template: Template,
  defaultFolder?: () => vscode.Uri | undefined,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    TEMPLATE_PANEL_VIEW_TYPE,
    `Template: ${template.title}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "dist"),
        vscode.Uri.joinPath(extensionUri, "media"),
      ],
    },
  );
  panel.webview.html = templatePanelHtml(
    panel.webview,
    extensionUri,
    cspNonce(),
  );
  const post = (m: TemplateHostMessage) => void panel.webview.postMessage(m);
  const view = templateView(template);
  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const msg = parseTemplatePanelMessage(raw);
    if (!msg) {
      return;
    }
    switch (msg.type) {
      case "ready":
        post({
          type: "template",
          template,
          ...view,
          profile: { label: profile.label, fqdn: profile.fqdn },
        });
        return;
      case "copyGrant":
        await deps.ui.copy(view.grantYaml);
        post({
          type: "result",
          ok: true,
          message: "Copied. Add it under spec in the Function manifest.",
        });
        return;
      case "create":
      case "fork": {
        post({ type: "busy", busy: true });
        try {
          const result =
            msg.type === "create"
              ? await createFromTemplate(
                  deps,
                  profile,
                  template,
                  msg.name,
                  msg.functionId,
                  msg.values,
                )
              : await forkTemplate(
                  deps,
                  profile,
                  template,
                  msg.functionId,
                  defaultFolder?.(),
                );
          post({ type: "result", ...result });
        } catch (err) {
          post({
            type: "result",
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          post({ type: "busy", busy: false });
        }
        return;
      }
    }
  });
  return panel;
}
