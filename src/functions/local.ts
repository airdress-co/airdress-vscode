import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { PublishBody } from "./wire";

/**
 * A function's source on disk: the folder, the file that says which
 * function it was read from, and the tree a publish carries.
 *
 * Nothing here decides anything the operator decides. The tree is the
 * layout the operator documents (`function.json` plus everything under
 * `src/`); the digest is the one it defines for signatures; the rest is
 * refused or admitted by the operator, not guessed at here.
 */

/**
 * The file beside `function.json` that remembers where a folder came
 * from. It is not part of the tree and is never published: the operator
 * refuses anything outside `function.json` and `src/`.
 */
export const CHECKOUT_FILE = ".airdress-function.json";

/** The manifest at the root of every source tree. */
export const MANIFEST_FILE = "function.json";

/** What a checkout records. */
export interface CheckoutRecord {
  /** The operator's FQDN — which profile to publish through. */
  readonly operator: string;
  /** The Function's `metadata.name`. */
  readonly function: string;
  /**
   * The version the tree was read from, sent as `basedOn`. Null for a
   * function that served nothing when the folder was made.
   */
  readonly basedOn: string | null;
  /** Versions this folder published, newest last. */
  readonly published?: readonly string[];
  /** The template the folder was made from, for the create prompt only. */
  readonly template?: string;
}

/** A folder with a checkout record. */
export interface Checkout {
  readonly root: vscode.Uri;
  readonly record: CheckoutRecord;
}

/** A source tree: archive path → bytes. */
export type SourceTree = Map<string, Uint8Array>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a checkout record; undefined for anything that is not one. */
export function parseCheckoutRecord(text: string): CheckoutRecord | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isRecord(v) ||
    typeof v.operator !== "string" ||
    typeof v.function !== "string" ||
    !(typeof v.basedOn === "string" || v.basedOn === null)
  ) {
    return undefined;
  }
  return {
    operator: v.operator,
    function: v.function,
    basedOn: v.basedOn,
    published: Array.isArray(v.published)
      ? v.published.filter((p): p is string => typeof p === "string")
      : undefined,
    template: typeof v.template === "string" ? v.template : undefined,
  };
}

export async function readCheckout(
  root: vscode.Uri,
): Promise<Checkout | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(root, CHECKOUT_FILE),
    );
    const record = parseCheckoutRecord(Buffer.from(bytes).toString("utf8"));
    return record ? { root, record } : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCheckout(
  root: vscode.Uri,
  record: CheckoutRecord,
): Promise<void> {
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(root, CHECKOUT_FILE),
    Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8"),
  );
}

/**
 * The checkout a file belongs to: the nearest folder above it holding a
 * checkout record. Undefined for a file in no checkout — a save there
 * has nothing to validate against.
 */
export async function checkoutFor(
  file: vscode.Uri,
): Promise<Checkout | undefined> {
  let dir = vscode.Uri.joinPath(file, "..");
  for (let i = 0; i < 32; i++) {
    const found = await readCheckout(dir);
    if (found) {
      return found;
    }
    const parent = vscode.Uri.joinPath(dir, "..");
    if (parent.path === dir.path) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/** The archive path of a file inside a checkout, or undefined. */
export function archivePathOf(
  root: vscode.Uri,
  file: vscode.Uri,
): string | undefined {
  const base = root.path.endsWith("/") ? root.path : `${root.path}/`;
  if (!file.path.startsWith(base)) {
    return undefined;
  }
  const rel = file.path.slice(base.length);
  return rel === MANIFEST_FILE || rel.startsWith("src/") ? rel : undefined;
}

/** A tree the client will not send, with the reason in the file's terms. */
export class LocalTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalTreeError";
  }
}

/**
 * Read `function.json` and everything under `src/`. A link is refused
 * rather than followed — the operator refuses links, and following one
 * here would publish bytes from outside the folder.
 */
export async function readTree(root: vscode.Uri): Promise<SourceTree> {
  const tree: SourceTree = new Map();
  try {
    tree.set(
      MANIFEST_FILE,
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(root, MANIFEST_FILE),
      ),
    );
  } catch {
    throw new LocalTreeError(
      `${root.fsPath} has no ${MANIFEST_FILE} — a source tree starts with one.`,
    );
  }
  const walk = async (dir: string): Promise<void> => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.joinPath(root, dir),
      );
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const rel = `${dir}/${name}`;
      if (type & vscode.FileType.SymbolicLink) {
        throw new LocalTreeError(
          `${rel} is a link; a source tree holds regular files only.`,
        );
      }
      if (type === vscode.FileType.Directory) {
        await walk(rel);
      } else if (type === vscode.FileType.File) {
        tree.set(
          rel,
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel)),
        );
      }
    }
  };
  await walk("src");
  return tree;
}

/** Domain separation for source signatures, as the operator defines it. */
export const SOURCE_DIGEST_DOMAIN = "airdress.function.source.v1";

/** Compare two strings by their UTF-8 bytes — the order the digest uses. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The canonical file-set digest a source signature covers:
 *
 *   D := SHA-256 over, for each file in byte-wise path order,
 *          u32_be(len(path)) ‖ path ‖ u64_be(len(contents)) ‖ contents
 *   canonical := SHA-256( DOMAIN ‖ 0x1F ‖ D )
 *
 * The operator's definition, reproduced so the editor can sign what it
 * publishes; a test holds it to the operator's own vectors.
 */
export function canonicalDigest(tree: ReadonlyMap<string, Uint8Array>): Buffer {
  const inner = crypto.createHash("sha256");
  for (const path of [...tree.keys()].sort(byteOrder)) {
    const p = Buffer.from(path, "utf8");
    const contents = tree.get(path)!;
    const pathLen = Buffer.alloc(4);
    pathLen.writeUInt32BE(p.length);
    const contentLen = Buffer.alloc(8);
    contentLen.writeBigUInt64BE(BigInt(contents.length));
    inner.update(pathLen).update(p).update(contentLen).update(contents);
  }
  return crypto
    .createHash("sha256")
    .update(Buffer.from(SOURCE_DIGEST_DOMAIN, "utf8"))
    .update(Buffer.from([0x1f]))
    .update(inner.digest())
    .digest();
}

/** `sha256:<64 hex>` — how the operator writes the digest. */
export function canonicalDigestString(
  tree: ReadonlyMap<string, Uint8Array>,
): string {
  return `sha256:${canonicalDigest(tree).toString("hex")}`;
}

/** PKCS#8 wrapping for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** An Ed25519 key the editor signs source with. */
export interface SourceSigningKey {
  /** Hex public key — what `spec.source.signer` names. */
  readonly publicKeyHex: string;
  sign(message: Uint8Array): Buffer;
}

/**
 * Parse a seed file: 64 hex characters, alone or as the `seed=` line
 * `airdress-operator functions keygen` prints.
 */
export function signingKeyFromSeedText(text: string): SourceSigningKey {
  const match = /(?:^|\n)\s*(?:seed=)?([0-9a-fA-F]{64})\s*(?:\n|$)/.exec(text);
  if (!match) {
    throw new LocalTreeError(
      "the signing key file does not hold a 64-hex-character Ed25519 seed",
    );
  }
  const seed = Buffer.from(match[1], "hex");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" });
  return {
    publicKeyHex: spki.subarray(spki.length - 32).toString("hex"),
    sign: (message) => crypto.sign(null, message, privateKey),
  };
}

/** Who signs a publish, from the editor's settings. */
export interface SigningChoice {
  readonly key?: SourceSigningKey;
  /** Name the signer as an approved machine instead of a key. */
  readonly machine?: string;
  /**
   * Where the key came from: a file named in settings, or the key this
   * workstation keeps in its keychain. Said in prompts, never the key.
   */
  readonly origin?: "file" | "keychain";
}

/**
 * The JSON publish body for a tree. The body type has no field that
 * could carry a grant, and the operator refuses unknown fields: a
 * publish never changes `spec.capabilities`.
 */
export function publishBody(
  name: string,
  basedOn: string | null,
  tree: ReadonlyMap<string, Uint8Array>,
  signing: SigningChoice,
): PublishBody {
  const files = [...tree.keys()].sort(byteOrder).map((path) => ({
    path,
    contentBase64: Buffer.from(tree.get(path)!).toString("base64"),
  }));
  const signature = signing.key
    ? signing.key.sign(canonicalDigest(tree)).toString("hex")
    : undefined;
  return {
    name,
    ...(basedOn ? { basedOn } : {}),
    ...(signature ? { signature } : {}),
    ...(signing.key && !signing.machine
      ? { signer: signing.key.publicKeyHex }
      : {}),
    ...(signing.machine ? { signerRef: { machine: signing.machine } } : {}),
    files,
  };
}

/** SHA-256 hex of one file — to compare a local file with the index. */
export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * The root of the tree a file belongs to: the nearest folder above it
 * holding `function.json`. Used for a folder with no checkout record — a
 * fork, or source written by hand.
 */
export async function treeRootFor(
  file: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  let dir = vscode.Uri.joinPath(file, "..");
  for (let i = 0; i < 32; i++) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, MANIFEST_FILE));
      return dir;
    } catch {
      const parent = vscode.Uri.joinPath(dir, "..");
      if (parent.path === dir.path) {
        return undefined;
      }
      dir = parent;
    }
  }
  return undefined;
}
