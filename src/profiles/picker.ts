import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { Profile } from "./model";
import { ProfileStore } from "./store";
import { isLocalhost, validateFqdn } from "./validate";

/**
 * Profile selection UI.
 *
 * There is NO ambient default profile (NFR-8). Every command resolves
 * its target through {@link resolveProfile}: either the command was
 * invoked on something that names a profile (a tree node), or the user
 * picks one interactively — with the active profile pre-selected as a
 * convenience, never silently substituted.
 */

/** The `airdress.dev.allowLocalhost` setting. */
export function devModeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("airdress.dev")
    .get<boolean>("allowLocalhost", false);
}

/**
 * Resolve the profile a command should act on.
 *
 * - `explicit` (e.g. from a tree node's context) wins outright.
 * - Otherwise the user always picks. The active profile is only the
 *   pre-selected row — a command never silently inherits it.
 */
export async function resolveProfile(
  store: ProfileStore,
  explicit?: Profile,
): Promise<Profile | undefined> {
  if (explicit) {
    return explicit;
  }
  const profiles = store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage(
      "Airdress: no profiles yet — run “Airdress: Add Operator Profile” first.",
    );
    return undefined;
  }
  const activeId = store.activeId();
  const items = profiles.map((p) => ({
    label: p.label,
    description: p.fqdn + (p.dev ? " (dev)" : ""),
    picked: p.id === activeId,
    profile: p,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select the operator profile for this action",
  });
  return picked?.profile;
}

/** Quick-pick switcher for the ACTIVE (status bar) profile. */
export async function pickProfile(store: ProfileStore): Promise<void> {
  const picked = await resolveProfile(store);
  if (picked) {
    await store.setActive(picked.id);
  }
}

/** Interactive profile creation (FR-25/FR-26). */
export async function addProfile(
  store: ProfileStore,
): Promise<Profile | undefined> {
  const allowLocalhost = devModeEnabled();

  const fqdn = (
    await vscode.window.showInputBox({
      title: "Airdress: Operator FQDN",
      prompt:
        "The operator's hostname — the `<uuid>.a.airdr.es` form. " +
        "Raw IP literals are rejected: they bypass the relay TLS path.",
      placeHolder: "019e2b8c-….a.airdr.es",
      ignoreFocusOut: true,
      validateInput: (value) => validateFqdn(value, { allowLocalhost }),
    })
  )?.trim();
  if (!fqdn) {
    return undefined;
  }

  const label = (
    await vscode.window.showInputBox({
      title: "Airdress: Profile Label",
      prompt: "A short display name for this operator profile.",
      value: fqdn.split(".")[0],
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length === 0 ? "Label must not be empty." : undefined,
    })
  )?.trim();
  if (!label) {
    return undefined;
  }

  const mode = await vscode.window.showQuickPick(
    [
      {
        label: "ZITADEL sign-in",
        description: "OIDC in the system browser (recommended)",
        authMode: "zitadel" as const,
      },
      {
        label: "Operator bearer token",
        description: "Paste an operator-issued token",
        authMode: "bearer" as const,
      },
    ],
    { placeHolder: "How does this profile authenticate?" },
  );
  if (!mode) {
    return undefined;
  }

  const profile: Profile = {
    id: crypto.randomUUID(),
    label,
    fqdn,
    authMode: mode.authMode,
    dev: isLocalhost(fqdn),
  };
  await store.add(profile, { allowLocalhost });
  await store.setActive(profile.id);
  return profile;
}

/** Status bar text — pure so the dev-state rendering is testable. */
export function statusBarText(profile: Profile | undefined): string {
  if (!profile) {
    return "$(radio-tower) airdress: no profile";
  }
  return `$(radio-tower) ${profile.label}${profile.dev ? " (dev)" : ""}`;
}

/** Create the status bar item reflecting the active profile. */
export function createStatusBar(store: ProfileStore): {
  item: vscode.StatusBarItem;
  refresh: () => void;
} {
  const item = vscode.window.createStatusBarItem(
    "airdress.activeProfile",
    vscode.StatusBarAlignment.Left,
    50,
  );
  item.name = "Airdress profile";
  item.command = "airdress.profiles.pick";
  const refresh = () => {
    const active = store.activeId();
    const profile = active ? store.get(active) : undefined;
    item.text = statusBarText(profile);
    item.tooltip = profile
      ? `${profile.fqdn}${profile.dev ? " — development profile (localhost allowed)" : ""}`
      : "Select an Airdress operator profile";
    item.show();
  };
  refresh();
  return { item, refresh };
}
