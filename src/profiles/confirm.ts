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

/**
 * Function source: publish a tree. Publishing stores a version and runs
 * nothing, and the prompt says so — the write that changes what runs is
 * still the apply.
 */
export function publishSourceConfirm(
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return (
    `Publish the source of ${name} to ${targetPhrase(profile)}? ` +
    "This stores a new version; nothing runs it until the Function " +
    "manifest names it and is applied."
  );
}

/** Function source: take the served version as this edit's base. */
export function rebaseSourceConfirm(
  name: string,
  version: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return (
    `Base this edit of ${name} on ${version}, the version it serves on ` +
    `${targetPhrase(profile)}? A publish from this folder then replaces ` +
    "that version's tree with this one — read the difference first."
  );
}

/** Templates: publish a template's tree as a new function. */
export function publishTemplateConfirm(
  templateTitle: string,
  name: string,
  profile: Pick<Profile, "label" | "fqdn">,
): string {
  return (
    `Publish "${templateTitle}" as ${name} to ${targetPhrase(profile)}? ` +
    "This stores its source as a version; nothing runs until you apply the " +
    "manifest the editor drafts next."
  );
}

/** A modal's headline and the text under it. */
export interface PromptText {
  readonly message: string;
  readonly detail: string;
}

/**
 * Deploy, replacing what an existing function runs. One prompt, before
 * the first write; the command line prints the same lines.
 */
export function deployReplaceConfirm(
  opts: {
    name: string;
    replacing: string;
    replacingNote?: string;
    version: string;
    files: number;
    unreached: number;
    signer: string;
  },
  profile: Pick<Profile, "label" | "fqdn">,
): PromptText {
  const reach =
    opts.unreached > 0 ? `; ${opts.unreached} not reached by an import` : "";
  return {
    message: `Deploy ${opts.name} on ${targetPhrase(profile)}?`,
    detail: [
      `replace  ${opts.replacing}${opts.replacingNote ? `  (${opts.replacingNote})` : ""}`,
      `with     ${opts.version}  (${opts.files} ${opts.files === 1 ? "file" : "files"}${reach})`,
      `signed by ${opts.signer}`,
      "The grant does not change.",
    ].join("\n"),
  };
}

/**
 * Deploy, creating a function. The grant is shown in full, as the YAML
 * that will be applied: creating a function is the owner deciding what it
 * may do, and nothing else in the loop asks that.
 */
export function deployCreateConfirm(
  opts: {
    name: string;
    template?: string;
    version: string;
    files: number;
    signers: string;
    grantYaml: string;
    configValues: number;
    secretValues: number;
  },
  profile: Pick<Profile, "label" | "fqdn">,
): PromptText {
  const from = opts.template ? ` from template "${opts.template}"` : "";
  const grant = opts.grantYaml.trim()
    ? [
        "It will be allowed to:",
        ...opts.grantYaml
          .trimEnd()
          .split("\n")
          .map((l) => `  ${l}`),
      ]
    : [
        "It will be allowed nothing beyond answering requests (no capabilities).",
      ];
  const config =
    opts.configValues === 0
      ? "Config: none"
      : `Config: ${opts.configValues} ${opts.configValues === 1 ? "value" : "values"} (${
          opts.secretValues === 0
            ? "none secret"
            : `${opts.secretValues} read from secrets`
        })`;
  return {
    message: `Create ${opts.name} on ${targetPhrase(profile)}${from}?`,
    detail: [
      `version  ${opts.version}  (${opts.files} ${opts.files === 1 ? "file" : "files"})`,
      `signers  ${opts.signers}`,
      ...grant,
      config,
    ].join("\n"),
  };
}

/**
 * A change to who may sign a function: its own apply, never part of a
 * Deploy, and never sent without the resulting set shown.
 */
export function signerSetConfirm(
  opts: {
    name: string;
    change: string;
    resulting: readonly string[];
    warning?: string;
  },
  profile: Pick<Profile, "label" | "fqdn">,
): PromptText {
  return {
    message: `${opts.change} for ${opts.name} on ${targetPhrase(profile)}?`,
    detail: [
      ...(opts.warning ? [opts.warning, ""] : []),
      "Allowed to sign afterwards:",
      ...opts.resulting.map((r) => `  - ${r}`),
      "",
      "This changes spec.source.signers and nothing else in the manifest. It deploys nothing.",
    ].join("\n"),
  };
}

/** Whether a prompt names its target the way this module promises. */
export function namesTarget(
  text: string,
  profile: Pick<Profile, "label" | "fqdn">,
): boolean {
  return text.includes(targetPhrase(profile));
}
