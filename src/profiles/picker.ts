import * as vscode from "vscode";
import { ProfileStore } from "./store";

/**
 * Quick-pick for switching the active profile.
 *
 * TODO(SPEC-057 T6-01): status-bar item reflecting the active profile.
 */
export async function pickProfile(store: ProfileStore): Promise<void> {
  const profiles = store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage(
      "Airdress: no profiles yet — run “Airdress: Add Operator Profile” first.",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.label,
      description: p.fqdn,
      id: p.id,
    })),
    { placeHolder: "Select the active operator profile" },
  );

  if (picked) {
    await store.setActive(picked.id);
  }
}
