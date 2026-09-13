import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { ApiError } from "../api/client";
import type { Profile } from "../profiles/model";
import { resolveProfile } from "../profiles/picker";
import { bundledSchemas } from "../manifests/schemas";
import { SchemaRegistry } from "../manifests/validate";
import {
  clientFor,
  diffAgainstLive,
  type ManifestDeps,
} from "../manifests/diff";
import { applyManifest } from "../manifests/apply";
import { ResourcePanelController, type ResourcePanelHost } from "./controller";
import { hasFunctionExtras } from "./kinds";
import {
  functionRoute,
  parseResourceStatus,
  type HostMessage,
  type InvocationResult,
  type ManifestObject,
} from "./protocol";

/**
 * The Function configuration panel — extension side.
 *
 * One webview per (profile, function). The HTML is a shell: a strict
 * CSP that allows exactly one nonce'd script (dist/webview.js) and one
 * stylesheet (media/function-panel.css), both served through
 * `asWebviewUri`; no inline script, no remote origin. The panel does
 * NOT retain its context when hidden — on re-show the browser side
 * asks for `load` again and the extension re-sends state, so the
 * panel never holds a stale copy of the operator's truth for long.
 *
 * Apply and diff go through the existing commands: the manifest is
 * opened as an untitled YAML document and `applyManifest` /
 * `diffAgainstLive` run on it exactly as they would on a file. That
 * keeps a single apply path (plan → validate → confirm naming profile
 * + FQDN → POST /v1/apply), and leaves the user holding the YAML the
 * panel produced, in an editor, to keep or discard.
 */

export const RESOURCE_PANEL_VIEW_TYPE = "airdress.resourceConfig";

export interface ResourcePanelDeps {
  manifest: ManifestDeps;
  extensionUri: vscode.Uri;
  /**
   * Overridable for tests; defaults to the live host. Must be a PLAIN
   * object: it is spread into the panel's host, and a spread keeps own
   * properties only — a class instance loses its methods.
   */
  hostFor?: (
    panel: vscode.WebviewPanel,
    profile: Profile,
    kind: string,
  ) => Omit<ResourcePanelHost, "post" | "close" | "profile">;
}

let registry: SchemaRegistry | undefined;
function schemaRegistry(): SchemaRegistry {
  registry ??= new SchemaRegistry(bundledSchemas());
  return registry;
}

/**
 * The Kind's published schema, or undefined when none is bundled.
 *
 * Undefined is not an error: it selects the raw-YAML fallback, which is
 * how a Kind the operator registers but has not published a schema for
 * stays creatable (FR-2). It gains a form for free the moment
 * `npm run sync:schemas` picks the schema up.
 */
function schemaFor(kind: string): Record<string, unknown> | undefined {
  const entry = bundledSchemas().find((s) => s.kind === kind);
  return entry?.schema as Record<string, unknown> | undefined;
}

const open = new Map<string, vscode.WebviewPanel>();

function panelKey(
  profile: Pick<Profile, "id">,
  kind: string,
  name: string | undefined,
): string {
  // Kind is part of the key: two Kinds may hold the same resource name,
  // and before the generic panel they would have shared one.
  return `${profile.id}/${kind}/${name ?? " new"}`;
}

/** Nonce for the CSP: 16 random bytes, base64. */
export function cspNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

/** The webview shell. Exported so a test can pin the CSP. */
export function panelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js"),
  );
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "function-panel.css"),
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
    "<title>Function</title>",
    "</head>",
    "<body>",
    '<main id="app" aria-live="polite">Loading…</main>',
    `<script nonce="${nonce}" src="${script.toString()}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Pre-supplied answers to the host's three modal prompts. Undefined —
 * every user path — shows the modal. Only `drivePanel` sets them, for
 * the duration of one driven message.
 */
export interface DriveAnswers {
  /** The apply confirm ("Apply" / cancel). */
  apply?: boolean;
  /** The 409 prompt; `null` is "cancel". */
  conflict?: "reload" | "overwrite" | null;
  /** The delete confirm. */
  delete?: boolean;
}

/**
 * The live host: every network call goes through the profile's
 * ApiClient (bearer from SecretStorage, never seen here), and apply /
 * diff go through the existing commands on an untitled document.
 */
export function liveHost(
  deps: ManifestDeps,
  profile: Profile,
  kind: string,
  answers: { current?: DriveAnswers } = {},
): Omit<ResourcePanelHost, "post" | "close" | "profile"> {
  const client = () => clientFor(deps, profile);
  const resourcePath = (name: string) =>
    `/v1/kinds/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;

  async function openAsYaml(yaml: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
      language: "yaml",
      content: yaml,
    });
    await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  return {
    async fetchManifest(name) {
      return client().request<ManifestObject>(resourcePath(name));
    },
    async fetchStatus(name) {
      return parseResourceStatus(
        await client().request<unknown>(`${resourcePath(name)}/status`),
      );
    },
    // `applyYaml` resolves only when the operator took the manifest.
    // `applyManifest` reports to the editor (a message, a diagnostic on
    // the untitled document) and used to return normally either way —
    // so the panel reloaded after a refused or cancelled apply and
    // showed "not found" for a create, and a 409 never reached the
    // controller's conflict handling at all. Seen on hardware.
    async applyYaml(yaml) {
      await openAsYaml(yaml);
      const outcome = await applyManifest(deps, profile, {
        confirm: answers.current?.apply,
      });
      if (outcome.status === "failed") {
        throw outcome.error;
      }
      if (outcome.status === "cancelled") {
        throw Object.assign(new Error(`apply cancelled — ${outcome.reason}`), {
          cancelled: true,
        });
      }
    },
    async diffYaml(yaml) {
      await openAsYaml(yaml);
      await diffAgainstLive(deps, profile);
    },
    async invoke(name, body): Promise<InvocationResult> {
      const started = Date.now();
      let contentType = "text/plain";
      try {
        JSON.parse(body);
        contentType = "application/json";
      } catch {
        // Not JSON — send it as text and let the function decide.
      }
      try {
        const response = await client().send(functionRoute(name), {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        });
        return {
          status: response.status,
          body: await response.text(),
          durationMs: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof ApiError) {
          return {
            status: err.httpStatus,
            body: [err.problem.title, err.problem.detail, err.problem.error]
              .filter(Boolean)
              .join(" — "),
            durationMs: Date.now() - started,
          };
        }
        return {
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    // CREATE pre-check. /v1/apply is an upsert; a 404 here is the good
    // answer. Anything else (403, 5xx) is not "free" — surface it so the
    // caller does not mistake "cannot tell" for "does not exist".
    async resourceExists(name) {
      try {
        await client().request<unknown>(resourcePath(name));
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.httpStatus === 404) {
          return false;
        }
        throw err;
      }
    },
    async confirmConflict(name) {
      if (answers.current?.conflict !== undefined) {
        return answers.current.conflict ?? undefined;
      }
      const choice = await vscode.window.showWarningMessage(
        `${kind}/${name} changed on ${profile.fqdn} since you opened it.`,
        {
          modal: true,
          detail:
            "Reload discards your edits and shows the operator's copy. " +
            "Overwrite reapplies your version on top of theirs.",
        },
        "Reload",
        "Overwrite",
      );
      return choice === "Reload"
        ? "reload"
        : choice === "Overwrite"
          ? "overwrite"
          : undefined;
    },
    async confirmDelete(name) {
      if (answers.current?.delete !== undefined) {
        return answers.current.delete;
      }
      const detail = hasFunctionExtras(kind)
        ? `${functionRoute(name)} stops answering immediately. The bundle file on the operator is not removed.`
        : `The reconciled effect of ${kind}/${name} is torn down. Files it named on the operator's disk are not removed.`;
      const choice = await vscode.window.showWarningMessage(
        `Delete ${kind}/${name} from profile "${profile.label}" (${profile.fqdn})?`,
        { modal: true, detail },
        "Delete",
      );
      return choice === "Delete";
    },
    async deleteResource(name) {
      await client().send(resourcePath(name), { method: "DELETE" });
    },
  };
}

/**
 * Open (or reveal) the configuration panel for one resource of `kind` on
 * a profile. `name` undefined opens an empty draft (create).
 */
export async function openResourcePanel(
  deps: ResourcePanelDeps,
  profile: Profile,
  kind: string,
  name: string | undefined,
): Promise<vscode.WebviewPanel> {
  const key = panelKey(profile, kind, name);
  const existing = open.get(key);
  if (existing) {
    existing.reveal();
    return existing;
  }
  const panel = vscode.window.createWebviewPanel(
    RESOURCE_PANEL_VIEW_TYPE,
    name ? `${kind}: ${name}` : `New ${kind}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [
        vscode.Uri.joinPath(deps.extensionUri, "dist"),
        vscode.Uri.joinPath(deps.extensionUri, "media"),
      ],
    },
  );
  panel.iconPath = new vscode.ThemeIcon(
    hasFunctionExtras(kind) ? "symbol-function" : "symbol-structure",
  );
  panel.webview.html = panelHtml(panel.webview, deps.extensionUri, cspNonce());
  open.set(key, panel);

  const answers: { current?: DriveAnswers } = {};
  const base = (
    deps.hostFor ?? ((_p, prof, k) => liveHost(deps.manifest, prof, k, answers))
  )(panel, profile, kind);
  const seam: DrivenPanel = {
    posted: [],
    answers,
    handle: async () => undefined,
  };
  // A delete closes the panel from inside `handle`, whose `finally`
  // still posts the idle "busy" message — onto a disposed webview,
  // which throws. Seen through the drive seam on 2026-09-13. After
  // dispose there is nobody to tell, so a post is dropped, not thrown.
  let disposed = false;
  const host: ResourcePanelHost = {
    ...base,
    profile: { label: profile.label, fqdn: profile.fqdn },
    post: (message: HostMessage) => {
      if (disposed) {
        return;
      }
      seam.posted.push(message);
      void panel.webview.postMessage(message);
    },
    close: () => panel.dispose(),
  };
  const controller = new ResourcePanelController(host, {
    kind,
    name,
    schema: schemaFor(kind),
    registry: schemaRegistry(),
  });

  const receive = (raw: unknown): Promise<void> =>
    controller.handle(raw).catch((err) => {
      host.post({
        type: "notice",
        level: "error",
        message: `Airdress: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  seam.handle = receive;
  driven.set(key, seam);
  panel.webview.onDidReceiveMessage((raw: unknown) => void receive(raw));
  panel.onDidDispose(() => {
    disposed = true;
    open.delete(key);
    driven.delete(key);
    // A draft that got applied is now addressable by name; the key it
    // was opened under is gone either way.
    if (controller.name && controller.name !== name) {
      open.delete(panelKey(profile, kind, controller.name));
    }
  });
  return panel;
}

interface DrivenPanel {
  /** Every message the host has posted to the webview, in order. */
  posted: HostMessage[];
  /** The live host's prompt answers; set only while a drive is in flight. */
  answers: { current?: DriveAnswers };
  /** The panel's own receive path — identical to `onDidReceiveMessage`. */
  handle: (raw: unknown) => Promise<void>;
}

const driven = new Map<string, DrivenPanel>();

/**
 * Feed one webview-shaped message into an OPEN panel's controller and
 * return everything the host posted back while handling it.
 *
 * This is the seam a script uses to drive the panel from outside the
 * window: `executeCommand` can open a panel but nothing outside the
 * webview can type into it, and the safety rails (modal confirms,
 * type-the-name delete) are precisely what a command cannot answer. The
 * message goes through the same `receive` the webview's own messages
 * do, and the posts come from the same `host.post`, so what a script
 * observes is what the webview would have been shown — the operator's
 * reload after an apply included. Exposed as a command only in
 * `ExtensionMode.Development` (extension.ts); a release build has no
 * caller.
 *
 * `answers` pre-answers the modal prompts the message may reach (the
 * apply confirm, the 409 prompt, the delete confirm) for this one
 * message only; an answer that is not supplied shows the modal as it
 * would for a person. The prompts are native dialogs on Linux and no
 * command can press them — which is also why the safety rails they
 * guard cannot be bypassed by a script that does not say so explicitly.
 */
export async function drivePanel(
  profile: Pick<Profile, "id" | "fqdn">,
  kind: string,
  name: string | undefined,
  message: unknown,
  answers?: DriveAnswers,
): Promise<HostMessage[]> {
  const seam = driven.get(panelKey(profile, kind, name));
  if (!seam) {
    throw new Error(
      `no open ${kind} panel for ${name ?? "<new>"} on ${profile.fqdn}`,
    );
  }
  const before = seam.posted.length;
  seam.answers.current = answers;
  try {
    await seam.handle(message);
  } finally {
    seam.answers.current = undefined;
  }
  return seam.posted.slice(before);
}

/** "Airdress: New Function…" — pick the profile, open an empty draft. */
export async function newFunctionCommand(
  deps: ResourcePanelDeps,
): Promise<void> {
  await newResourceCommand(deps, "Function");
}

/**
 * "Airdress: New Resource…" — pick the profile, then open an empty draft
 * for `kind`. Callers that already know the Kind pass it; the command
 * that does not asks first (see `pickKind` in extension.ts).
 */
export async function newResourceCommand(
  deps: ResourcePanelDeps,
  kind: string,
): Promise<void> {
  const profile = await resolveProfile(deps.manifest.profiles);
  if (!profile) {
    return;
  }
  await openResourcePanel(deps, profile, kind, undefined);
}
