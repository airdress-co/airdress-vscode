import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { Profile } from "./model";
import { ProfileStore } from "./store";
import { isLocalhost, validateFqdn } from "./validate";

/**
 * Profile selection UI.
 *
 * The ACTIVE profile is the standing target: a command acts on it
 * without asking. That reverses the original NFR-8 ("no ambient
 * default"), deliberately: the pick in front of every action was the
 * guard only while the selection was a status-bar item nobody looked
 * at. The selector view makes the selection something you always see,
 * and every mutating confirm still names the target by label AND FQDN
 * (`profiles/confirm.ts`, each wording under test). A command invoked
 * on something that names a profile — a tree row, an argument — always
 * wins over the active one. With nothing active, the pick returns.
 */

/** The `airdress.dev.allowLocalhost` setting. */
export function devModeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("airdress.dev")
    .get<boolean>("allowLocalhost", false);
}

/** How a profile is chosen when nothing else decides — injectable for tests. */
export type ProfilePicker = (
  profiles: Profile[],
  activeId: string | undefined,
) => Promise<Profile | undefined>;

/** The quick-pick, with the active profile pre-selected. */
export const quickPickProfile: ProfilePicker = async (profiles, activeId) => {
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
};

/**
 * Resolve the profile a command should act on:
 *
 * 1. `explicit` (a tree row's context, an argument) wins outright.
 * 2. Otherwise the ACTIVE profile, when the store still has it — no pick.
 * 3. Otherwise the user picks (`pick`, the quick-pick by default).
 */
export async function resolveProfile(
  store: ProfileStore,
  explicit?: Profile,
  pick: ProfilePicker = quickPickProfile,
): Promise<Profile | undefined> {
  if (explicit) {
    return explicit;
  }
  const profiles = store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage(
      "Airdress: no profiles yet — run “Airdress: Connect an Airdress” first.",
    );
    return undefined;
  }
  const activeId = store.activeId();
  const active = activeId ? profiles.find((p) => p.id === activeId) : undefined;
  if (active) {
    return active;
  }
  return pick(profiles, activeId);
}

/** Switch the ACTIVE profile: always a pick, never the current one. */
export async function pickProfile(
  store: ProfileStore,
  pick: ProfilePicker = quickPickProfile,
): Promise<void> {
  const profiles = store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage(
      "Airdress: no profiles yet — run “Airdress: Connect an Airdress” first.",
    );
    return;
  }
  const picked = await pick(profiles, store.activeId());
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

  // The same airdress added twice is a re-sign-in of the row that
  // exists, never a twin: the caller signs in under the returned id.
  const existing =
    mode.authMode === "zitadel" ? store.findByFqdn(fqdn) : undefined;
  if (existing) {
    void vscode.window.showInformationMessage(
      `Airdress: a profile for ${fqdn} already exists ("${existing.label}") — signing in to it again.`,
    );
    await store.setActive(existing.id);
    return existing;
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
  // Click opens the selector view — the status bar mirrors, it does not lead.
  item.command = "airdress.selector.focus";
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
