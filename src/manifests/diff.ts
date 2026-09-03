import * as vscode from "vscode";
import * as YAML from "yaml";
import { ApiClient, ApiError, baseUrlFor } from "../api/client";
import type { AuthManager } from "../auth/manager";
import type { Profile } from "../profiles/model";
import { ProfileStore } from "../profiles/store";
import { resolveProfile } from "../profiles/picker";
import { parseManifest } from "./validate";
import { LiveManifestProvider } from "./virtual";

/**
 * Diff-then-apply flow (design §5.1): fetch live -> read-only virtual
 * doc -> vscode.diff against the working tree. Nothing is written.
 */

export interface ManifestDeps {
  profiles: ProfileStore;
  auth: AuthManager;
  provider: LiveManifestProvider;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export function clientFor(deps: ManifestDeps, profile: Profile): ApiClient {
  const cfg = vscode.workspace.getConfiguration("airdress");
  return new ApiClient({
    baseUrl: baseUrlFor(profile),
    getToken: () =>
      deps.auth.getAccessToken({ id: profile.id, authMode: profile.authMode }),
    timeoutMs: cfg.get<number>("requestTimeoutMs", 15_000),
    traceHeader: cfg.get<boolean>("telemetry.traceHeader", false),
    fetchFn: deps.fetchFn,
    profileLabel: profile.label,
  });
}

/** The manifest document the command was invoked on. */
function activeManifestDocument(): vscode.TextDocument | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !["yaml", "json"].includes(doc.languageId)) {
    void vscode.window.showWarningMessage(
      "Airdress: open a YAML or JSON manifest first.",
    );
    return undefined;
  }
  return doc;
}

/**
 * "Airdress: Diff Manifest Against Live" — publishes the live state at
 * airdress://<profile>/<kind>/<name>.yaml and opens vscode.diff.
 */
export async function diffAgainstLive(
  deps: ManifestDeps,
  explicitProfile?: Profile,
): Promise<void> {
  const doc = activeManifestDocument();
  if (!doc) {
    return;
  }
  const parsed = parseManifest(doc.getText());
  if ("error" in parsed) {
    void vscode.window.showErrorMessage(
      `Airdress: cannot diff — ${parsed.error}`,
    );
    return;
  }
  const { kind, metadata } = parsed.envelope;

  // Explicit profile resolution — never an ambient default (NFR-8).
  const profile = await resolveProfile(deps.profiles, explicitProfile);
  if (!profile) {
    return;
  }

  let liveYaml: string;
  try {
    const live = await clientFor(deps, profile).request<unknown>(
      `/v1/kinds/${encodeURIComponent(kind)}/${encodeURIComponent(metadata.name)}`,
    );
    liveYaml = YAML.stringify(live);
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404) {
      liveYaml = `# ${kind}/${metadata.name} does not exist on ${profile.fqdn} yet.\n`;
    } else {
      void vscode.window.showErrorMessage(
        `Airdress: fetching live state from ${profile.fqdn} failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
  }

  const liveUri = deps.provider.publish(
    profile.id,
    kind,
    metadata.name,
    liveYaml,
  );
  await vscode.commands.executeCommand(
    "vscode.diff",
    liveUri,
    doc.uri,
    `${kind}/${metadata.name} — ${profile.label} (live) ⟷ working tree`,
  );
}
