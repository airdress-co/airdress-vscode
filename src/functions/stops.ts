import type { SourceRefusal } from "./wire";

/**
 * Why a Deploy stopped, as one closed list.
 *
 * The command line client stops for the same reasons under the same
 * codes, so a person reading either one learns one vocabulary. Both
 * repositories carry the list as `deploy-stops.txt`, one code per line in
 * this order, and a test holds this array to that file.
 *
 * An operator refusal is not one of these: it passes through verbatim,
 * under the step that received it (see `DeployRefused`). A refusal code
 * this editor does not know is shown as it arrived and stops the loop,
 * never coerced into a known one.
 */
export const DEPLOY_STOP_CODES = [
  "check_failed",
  "digest_mismatch",
  "signer_unavailable",
  "signer_not_this_client",
  "confirmation_declined",
  "operator_predates_promote",
  "not_loaded_in_time",
  "load_failed",
  "function_missing",
  "layout_invalid",
  "superseded",
  "write_back_failed",
  "machine_authorization_expired",
] as const;

export type DeployStopCode = (typeof DEPLOY_STOP_CODES)[number];

/** The loop's steps, named as both clients name them. */
export type DeployStep =
  | "resolve"
  | "check"
  | "digest"
  | "confirm"
  | "sign"
  | "publish"
  | "promote"
  | "apply"
  | "wait";

/** A stop the client decided, with the sentence it shows. */
export class DeployStop extends Error {
  constructor(
    readonly code: DeployStopCode,
    message: string,
    /** The operator refusal behind it, when there is one. */
    readonly refusal?: SourceRefusal,
  ) {
    super(message);
    this.name = "DeployStop";
  }
}

/** Whether a string is one of the stop codes. */
export function isDeployStopCode(code: string): code is DeployStopCode {
  return (DEPLOY_STOP_CODES as readonly string[]).includes(code);
}
