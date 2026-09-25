import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  signingKeyFromSeedText,
  type SigningChoice,
  type SourceSigningKey,
} from "./local";

/**
 * The key this workstation signs function source with.
 *
 * A person deploying for the first time should not have to make a key
 * somewhere else first. So the editor makes one: an Ed25519 key,
 * generated here and kept in the operating system's keychain through
 * VS Code's secret storage. Only its public half ever leaves: it is what
 * a Function's `spec.source.signers` names as `{ key }`.
 *
 * Precedence: a key file named in `airdress.functions.signingKeyFile`
 * wins, so a person who already keeps a key (for the command line too)
 * keeps using it. Otherwise the keychain's.
 *
 * The private half is read into a signing closure and nowhere else. It is
 * never put in a message, a log, a setting or a request; a test drives a
 * whole Deploy through a recording HTTP client and asserts that.
 */

/** The secret-storage key the private half is kept under. */
export const SIGNING_SEED_SECRET = "airdress.functions.signingSeed";

/** The slice of `vscode.SecretStorage` this module uses. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

/** Thirty-two random bytes, as hex: a fresh Ed25519 private key. */
export function generateSeedHex(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** The keychain's key, if this workstation has one. */
export async function keychainKey(
  secrets: SecretStore,
): Promise<SourceSigningKey | undefined> {
  const stored = await secrets.get(SIGNING_SEED_SECRET);
  if (!stored) {
    return undefined;
  }
  return signingKeyFromSeedText(stored);
}

/** Make a key and keep it in the keychain. Refuses to replace one. */
export async function createKeychainKey(
  secrets: SecretStore,
): Promise<SourceSigningKey> {
  const existing = await keychainKey(secrets);
  if (existing) {
    return existing;
  }
  const seed = generateSeedHex();
  await secrets.store(SIGNING_SEED_SECRET, seed);
  return signingKeyFromSeedText(seed);
}

/** `~/…` expanded, as a person writes a path in settings. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? `${os.homedir()}${p.slice(1)}` : p;
}

/** Where the signing key comes from: settings, then the keychain. */
export interface SigningSettings {
  /** `airdress.functions.signingKeyFile`, as written. */
  readonly keyFile: string;
  /** `airdress.functions.signerMachine`, as written. */
  readonly machine: string;
}

/**
 * The key to sign with now. A file named in settings wins; otherwise the
 * keychain's key; otherwise none (`key` undefined), which a Deploy turns
 * into an offer to make one.
 */
export async function resolveSigning(
  settings: SigningSettings,
  secrets: SecretStore,
): Promise<SigningChoice> {
  const machine = settings.machine.trim() || undefined;
  const keyFile = settings.keyFile.trim();
  if (keyFile) {
    let text: string;
    try {
      text = await fs.readFile(expandHome(keyFile), "utf8");
    } catch {
      throw new Error(
        `the signing key file ${keyFile} (airdress.functions.signingKeyFile) cannot be read`,
      );
    }
    return { key: signingKeyFromSeedText(text), machine, origin: "file" };
  }
  const key = await keychainKey(secrets);
  return key ? { key, machine, origin: "keychain" } : { machine };
}

/**
 * The keychain's key written to a file, in the form the command line
 * reads (`--signing-key`), readable by its owner only. Returns false when
 * the keychain holds no key.
 */
export async function exportKeychainKey(
  secrets: SecretStore,
  file: string,
): Promise<boolean> {
  const stored = await secrets.get(SIGNING_SEED_SECRET);
  if (!stored) {
    return false;
  }
  // Validate before writing: never export something that is not a key.
  signingKeyFromSeedText(stored);
  await fs.writeFile(file, `${stored.trim()}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return true;
}
