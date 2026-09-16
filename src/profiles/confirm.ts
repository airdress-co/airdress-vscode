import type { Profile } from "./model";

/**
 * The wording of every prompt that stands in front of a write.
 *
 * With the profile quick-pick gone from in front of commands, the
 * confirm is the only place the user still reads WHERE a write goes.
 * Every function here therefore names the target profile by label AND
 * FQDN, and a test asserts it for each one — the guard is the naming,
 * and the naming is checked, not intended. Pure functions: the dialogs
 * that show them live beside the code that needs them.
 */

/** `profile "<label>" (<fqdn>)` — the one form every prompt uses. */
export function targetPhrase(profile: Pick<Profile, "label" | "fqdn">): string {
  return `profile "${profile.label}" (${profile.fqdn})`;
}

/** Resource panel: the delete confirm's headline. */
export function deleteResourceConfirm(
  kind: string,
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return `Delete ${kind}/${name} from ${targetPhrase(profile)}?`;
}

/** Tree row: the type-to-confirm delete prompt. */
export function deleteResourcePrompt(
  kind: string,
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return (
    `This removes ${kind}/${name} from ${targetPhrase(profile)}. ` +
    "Files the resource named on the operator's disk are not removed. " +
    "Type the name to confirm."
  );
}

/** Resource panel: the 409 prompt — Overwrite is a write. */
export function conflictMessage(
  kind: string,
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return `${kind}/${name} changed on ${targetPhrase(profile)} since you opened it.`;
}

/** Principals: create a sub-user. */
export function createSubUserConfirm(
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return `Create sub-user '${name}' on ${targetPhrase(profile)}?`;
}

/** Principals: the revoke type-to-confirm title. */
export function revokeSubUserTitle(
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return `Airdress: Revoke sub-user '${name}' on ${targetPhrase(profile)}`;
}

/** Principals: attach an identity — a write the old prompt never located. */
export function bindIdentityPrompt(
  issuer: string,
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return (
    `Attach an identity to '${name}' on ${targetPhrase(profile)}. ` +
    `Issuer (from this profile's auth configuration): ${issuer} — ` +
    "enter the subject (sub) of the identity to attach. Binding is " +
    "idempotent: repeating it with the same identity is a no-op."
  );
}

/** Enrollments: revoke one device's enrollment. */
export function revokeEnrollmentConfirm(
  enrollment: { id: string; deviceLabel?: string; airdress?: string },
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  const label = enrollment.deviceLabel ? ` '${enrollment.deviceLabel}'` : "";
  return `Revoke enrollment${label} (${enrollment.id}) on ${targetPhrase(profile)}?`;
}

/** Whether a prompt names its target the way this module promises. */
export function namesTarget(
  text: string,
  profile: Pick<Profile, "label" | "fqdn">,
): boolean {
  return text.includes(targetPhrase(profile));
}
