import * as vscode from "vscode";
import * as YAML from "yaml";
import { ApiError } from "../api/client";
import { clientFor, type ManifestDeps } from "../manifests/diff";
import { planApplyDocuments } from "../manifests/scope";
import type { Profile } from "../profiles/model";
import {
  addEntries,
  MAPPING_PATH,
  parseMapping,
  serializeMapping,
  type ManifestMapping,
} from "./mapping";
import { classifyDrift, type DriftRow, type MappedObservation } from "./scan";

/**
 * Drift commands. Reading only: the scan fetches and compares, and its
 * rows offer a DIFF — never a write. Applying still means the ordinary
 * apply command, with its own confirmation naming the target.
 */

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function readMappingFile(
  root: vscode.Uri,
): Promise<{ mapping: ManifestMapping } | { error: string } | undefined> {
  const uri = vscode.Uri.joinPath(root, MAPPING_PATH);
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined; // no mapping yet
  }
  return parseMapping(new TextDecoder().decode(bytes));
}

async function writeMappingFile(
  root: vscode.Uri,
  mapping: ManifestMapping,
): Promise<vscode.Uri> {
  const uri = vscode.Uri.joinPath(root, MAPPING_PATH);
  await vscode.workspace.fs.writeFile(
    uri,
    new TextEncoder().encode(serializeMapping(mapping)),
  );
  return uri;
}

/**
 * "Airdress: Add Open Manifest to Drift Mapping" — the explicit act
 * that puts a file under drift management. Adds every resource the
 * open file declares, then opens the mapping so the result is SEEN.
 */
export async function addOpenFileToMapping(deps: ManifestDeps): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !["yaml", "json"].includes(doc.languageId)) {
    void vscode.window.showWarningMessage(
      "Airdress: open the YAML or JSON manifest you want mapped first.",
    );
    return;
  }
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage(
      "Airdress: the drift mapping lives in the workspace — open a folder first.",
    );
    return;
  }
  if (!doc.uri.fsPath.startsWith(root.fsPath)) {
    void vscode.window.showWarningMessage(
      "Airdress: the manifest must live inside the workspace to be mapped.",
    );
    return;
  }
  const plan = planApplyDocuments(doc.getText(), doc.languageId);
  if ("error" in plan) {
    void vscode.window.showErrorMessage(
      `Airdress: cannot map this file — ${plan.error}`,
    );
    return;
  }
  const relativePath = vscode.workspace
    .asRelativePath(doc.uri, false)
    .replaceAll("\\", "/");

  const existing = await readMappingFile(root);
  let mapping: ManifestMapping;
  if (existing === undefined) {
    // First entry: the mapping's profile is chosen explicitly, from
    // the configured profiles — never assumed.
    const profiles = deps.profiles.list();
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage(
        "Airdress: add an operator profile first — the mapping names the operator it maps onto.",
      );
      return;
    }
    const activeId = deps.profiles.activeId();
    const picked = await vscode.window.showQuickPick(
      profiles.map((p) => ({
        label: p.fqdn,
        description: p.label,
        picked: p.id === activeId,
      })),
      { placeHolder: "Which operator does this workspace map onto?" },
    );
    if (!picked) {
      return;
    }
    mapping = { profile: picked.label, manifests: [] };
  } else if ("error" in existing) {
    void vscode.window.showErrorMessage(
      `Airdress: ${existing.error} — fix it by hand (it is a plain JSON file) and retry.`,
    );
    return;
  } else {
    mapping = existing.mapping;
  }

  mapping = addEntries(
    mapping,
    plan.docs.map((d) => ({ path: relativePath, kind: d.kind, name: d.name })),
  );
  const uri = await writeMappingFile(root, mapping);
  // Show the result: the mapping is a file a human reads and fixes.
  const opened = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(opened, { preview: true });
  void vscode.window.showInformationMessage(
    `Airdress: mapped ${plan.docs.map((d) => `${d.kind}/${d.name}`).join(", ")} → ${relativePath}.`,
  );
}

function rowLabel(row: DriftRow): string {
  const icons: Record<DriftRow["classification"], string> = {
    "in-sync": "$(check)",
    drifted: "$(git-compare)",
    missing: "$(warning)",
    unmanaged: "$(question)",
  };
  return `${icons[row.classification]} ${row.kind}/${row.name}`;
}

/**
 * "Airdress: Detect Drift (Workspace)" — classify every mapped
 * manifest and every unmapped live resource; a row's action is a DIFF.
 */
export async function detectWorkspaceDrift(deps: ManifestDeps): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage(
      "Airdress: open the workspace folder that carries the drift mapping first.",
    );
    return;
  }
  const read = await readMappingFile(root);
  if (read === undefined) {
    void vscode.window.showInformationMessage(
      `Airdress: no ${MAPPING_PATH} yet — run “Airdress: Add Open Manifest to Drift Mapping” to create it.`,
    );
    return;
  }
  if ("error" in read) {
    void vscode.window.showErrorMessage(`Airdress: ${read.error}`);
    return;
  }
  const { mapping } = read;
  const profile = deps.profiles.list().find((p) => p.fqdn === mapping.profile);
  if (!profile) {
    void vscode.window.showErrorMessage(
      `Airdress: the mapping names ${mapping.profile}, but no configured profile has that FQDN — add the profile, or fix the mapping.`,
    );
    return;
  }

  const client = clientFor(deps, profile);

  // Observe every mapped entry: local parse + live fetch.
  const observations: MappedObservation[] = await Promise.all(
    mapping.manifests.map(async (entry): Promise<MappedObservation> => {
      const observation: MappedObservation = { entry };
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(root, entry.path),
        );
        observation.localDoc = YAML.parse(new TextDecoder().decode(bytes));
      } catch (err) {
        observation.localError =
          err instanceof Error ? err.message : String(err);
      }
      try {
        observation.liveDoc = await client.request<unknown>(
          `/v1/kinds/${encodeURIComponent(entry.kind)}/${encodeURIComponent(entry.name)}`,
        );
      } catch (err) {
        if (!(err instanceof ApiError && err.httpStatus === 404)) {
          throw err; // unreachable operator etc. — surfaced below
        }
        // 404: liveDoc stays undefined → classified `missing`.
      }
      return observation;
    }),
  ).catch((err) => {
    void vscode.window.showErrorMessage(
      `Airdress: drift scan against ${profile.fqdn} failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  });
  if (observations.length === 0 && mapping.manifests.length > 0) {
    return; // scan failed and was reported
  }

  // Live inventory for `unmanaged` detection. `missing` and
  // `unmanaged` are drift and are shown — never skipped.
  let liveInventory: Array<{ kind: string; name: string }> = [];
  try {
    const { kinds } = await client.request<{ kinds: string[] }>("/v1/kinds");
    const listings = await Promise.all(
      kinds.map((kind) =>
        client.request<{ items: Array<{ kind: string; name: string }> }>(
          `/v1/kinds/${encodeURIComponent(kind)}`,
        ),
      ),
    );
    liveInventory = listings.flatMap((l) =>
      l.items.map((r) => ({ kind: r.kind, name: r.name })),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Airdress: listing live resources on ${profile.fqdn} failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const rows = classifyDrift(observations, liveInventory);
  const drifted = rows.filter((r) => r.classification !== "in-sync").length;
  const picked = await vscode.window.showQuickPick(
    rows.map((row) => ({
      label: rowLabel(row),
      description: row.classification,
      detail: row.detail ?? row.path,
      row,
    })),
    {
      placeHolder:
        drifted === 0
          ? `No drift: ${rows.length} mapped resources are in sync with ${profile.fqdn}.`
          : `${drifted} of ${rows.length} rows differ from ${profile.fqdn} — select one to diff (nothing is applied).`,
    },
  );
  if (!picked) {
    return;
  }
  await openDriftDiff(deps, profile, picked.row, root);
}

/** Per-row action: the existing live-vs-local diff. Read-only. */
async function openDriftDiff(
  deps: ManifestDeps,
  profile: Profile,
  row: DriftRow,
  root: vscode.Uri,
): Promise<void> {
  let liveText: string;
  try {
    const live = await clientFor(deps, profile).request<unknown>(
      `/v1/kinds/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.name)}`,
    );
    liveText = YAML.stringify(live);
  } catch (err) {
    liveText =
      err instanceof ApiError && err.httpStatus === 404
        ? `# ${row.kind}/${row.name} does not exist on ${profile.fqdn}.\n`
        : `# fetching ${row.kind}/${row.name} failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`;
  }
  const liveUri = deps.provider.publish(
    profile.id,
    row.kind,
    row.name,
    liveText,
  );
  if (row.path) {
    await vscode.commands.executeCommand(
      "vscode.diff",
      liveUri,
      vscode.Uri.joinPath(root, row.path),
      `${row.kind}/${row.name} — ${profile.label} (live) ⟷ ${row.path}`,
    );
  } else {
    // Unmanaged: no local file to diff against — open the live state.
    const doc = await vscode.workspace.openTextDocument(liveUri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}
