import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type * as vscodeTypes from "vscode";
import {
  bindOidcIdentity,
  createSubUser,
  revocationGate,
  revokeSubUser,
  showPrincipalMetadata,
  type PrincipalAdminDeps,
  type PrincipalAdminUI,
} from "../principals/admin";
import {
  metadataLines,
  toAdminMetadata,
  type SubUserAdminMetadata,
} from "../principals/metadata";
import { ProfileStore } from "../profiles/store";
import { AuthManager } from "../auth/manager";
import { SecretStore } from "../auth/store";
import { LiveManifestProvider } from "../manifests/virtual";
import type { ManifestDeps } from "../manifests/diff";
import type { Profile } from "../profiles/model";
import type { TreeNodeData } from "../tree/nodes";

/* ------------------------------------------------------------------ *
 * The sub-user isolation boundary, re-verified at THIS surface: the
 * metadata view's type cannot hold content. Compile-time assertions.
 * ------------------------------------------------------------------ */
type AssertNever<T extends never> = T;
type ContentKeys =
  | "content"
  | "message"
  | "messages"
  | "blocks"
  | "body"
  | "text"
  | "plaintext"
  | "ciphertext"
  | "conversation"
  | "conversations";
type MetadataContentValues = Exclude<
  SubUserAdminMetadata[Extract<keyof SubUserAdminMetadata, ContentKeys>],
  undefined
>;
export type MetadataHasNoContentFields = AssertNever<MetadataContentValues>;
type MetadataNonStrings = Exclude<
  Exclude<SubUserAdminMetadata[keyof SubUserAdminMetadata], never>,
  string | undefined
>;
export type MetadataFieldsAreScalars = AssertNever<MetadataNonStrings>;

class FakeMemento implements vscodeTypes.Memento {
  private readonly stored = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.stored.keys()];
  }
  get<T>(key: string, defaultValue?: T): T {
    return (this.stored.get(key) as T) ?? (defaultValue as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    this.stored.set(key, value);
  }
}

class FakeSecretStorage implements vscodeTypes.SecretStorage {
  readonly stored = new Map<string, string>();
  private readonly emitter =
    new vscode.EventEmitter<vscodeTypes.SecretStorageChangeEvent>();
  onDidChange = this.emitter.event;
  async get(key: string): Promise<string | undefined> {
    return this.stored.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.stored.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.stored.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.stored.keys()];
  }
}

const OWNER: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "bearer",
  dev: false,
};

const SECRET_TOKEN = "one-shot-credential-000111222";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Harness {
  deps: PrincipalAdminDeps;
  calls: Call[];
  secrets: FakeSecretStorage;
  profiles: ProfileStore;
  infos: string[];
  errors: string[];
}

async function harness(
  respond: (call: Call) => Response,
  ui: Partial<PrincipalAdminUI>,
): Promise<Harness> {
  const calls: Call[] = [];
  const secrets = new FakeSecretStorage();
  const secretStore = new SecretStore(secrets);
  const auth = new AuthManager(secretStore);
  const profiles = new ProfileStore(new FakeMemento());
  await profiles.add(OWNER);
  await auth.setBearer(OWNER.id, "owner-bearer");
  const manifest: ManifestDeps = {
    profiles,
    auth,
    provider: new LiveManifestProvider(),
    fetchFn: (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  };
  const infos: string[] = [];
  const errors: string[] = [];
  const fullUi: PrincipalAdminUI = {
    promptDisplayName: async () => undefined,
    confirmCreate: async () => false,
    revealToken: async () => "done",
    promptRevokeName: async () => undefined,
    offerRunbook: async () => undefined,
    promptOidcSub: async () => undefined,
    info: (m) => infos.push(m),
    error: (m) => errors.push(m),
    ...ui,
  };
  const deps: PrincipalAdminDeps = {
    manifest,
    ui: fullUi,
    addBearerProfile: async (profile, displayName, token) => {
      const p: Profile = {
        id: `added-${displayName}`,
        label: `${displayName} @ ${profile.label}`,
        fqdn: profile.fqdn,
        authMode: "bearer",
        dev: false,
      };
      await profiles.add(p);
      await auth.setBearer(p.id, token);
    },
    copyToClipboard: async (token) => {
      await vscode.env.clipboard.writeText(token);
    },
    refreshPrincipals: () => undefined,
  };
  return { deps, calls, secrets, profiles, infos, errors };
}

const PRINCIPAL_NODE: TreeNodeData = {
  type: "principal",
  profile: OWNER,
  principal: {
    id: "sub-1",
    displayName: "alice",
    createdAt: "2026-09-01T00:00:00Z",
  },
};

suite("sub-user creation — one-shot reveal", () => {
  test("after dismissing the reveal, the credential is NOWHERE: not in SecretStorage, not in the clipboard, not in any profile", async () => {
    const clipboardSentinel = "clipboard-untouched-sentinel";
    await vscode.env.clipboard.writeText(clipboardSentinel);
    let revealedToken: string | undefined;
    const h = await harness(
      (call) =>
        call.method === "POST"
          ? jsonResponse(201, { id: "sub-9", token: SECRET_TOKEN })
          : jsonResponse(200, []),
      {
        promptDisplayName: async () => "alice",
        confirmCreate: async (name, profile) => {
          assert.strictEqual(name, "alice");
          assert.strictEqual(profile.fqdn, "ada.a.airdr.es");
          return true;
        },
        revealToken: async (_name, token) => {
          revealedToken = token;
          return "done"; // dismiss without copying or storing
        },
      },
    );
    await createSubUser(h.deps, OWNER);
    assert.strictEqual(revealedToken, SECRET_TOKEN, "token was revealed once");
    // Not in SecretStorage (the only secret is the owner's own bearer):
    assert.deepStrictEqual(
      [...h.secrets.stored.values()],
      ["owner-bearer"],
      "the new credential must not be stored on the user's behalf",
    );
    // Not in the clipboard:
    assert.strictEqual(
      await vscode.env.clipboard.readText(),
      clipboardSentinel,
    );
    // Not as a profile:
    assert.strictEqual(h.profiles.list().length, 1);
  });

  test("'Add as profile' is a separate deliberate action that stores the bearer", async () => {
    const h = await harness(
      () => jsonResponse(201, { id: "sub-9", token: SECRET_TOKEN }),
      {
        promptDisplayName: async () => "alice",
        confirmCreate: async () => true,
        revealToken: async () => "add-profile",
      },
    );
    await createSubUser(h.deps, OWNER);
    assert.strictEqual(h.profiles.list().length, 2);
    assert.ok(
      [...h.secrets.stored.values()].includes(SECRET_TOKEN),
      "the deliberate add-as-profile choice stores the bearer",
    );
  });

  test("the default reveal dialog states non-recoverability in those terms and never auto-copies", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "principals", "admin.ts"),
      "utf8",
    );
    assert.match(source, /shown once and cannot be recovered/);
    assert.match(source, /NOT stored by this extension/);
  });
});

suite("sub-user revocation — type-to-confirm", () => {
  test("the gate passes ONLY the exact name", () => {
    assert.strictEqual(revocationGate("alice", "alice"), true);
    assert.strictEqual(revocationGate("Alice", "alice"), false);
    assert.strictEqual(revocationGate("alice ", "alice"), false);
    assert.strictEqual(revocationGate("", "alice"), false);
    assert.strictEqual(revocationGate("bob", "alice"), false);
  });

  test("a cancelled or mismatched confirmation sends NO request — no OK-only path exists", async () => {
    const h = await harness(() => jsonResponse(204), {
      promptRevokeName: async () => undefined,
    });
    await revokeSubUser(h.deps, PRINCIPAL_NODE);
    assert.strictEqual(h.calls.length, 0);
  });

  test("the typed name revokes, exactly once", async () => {
    const h = await harness(() => jsonResponse(204), {
      promptRevokeName: async (name) => name,
    });
    await revokeSubUser(h.deps, PRINCIPAL_NODE);
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].method, "DELETE");
    assert.match(h.calls[0].url, /\/v1\/admin\/sub-users\/sub-1$/);
    assert.ok(h.infos.some((m) => /revoked on ada\.a\.airdr\.es/.test(m)));
  });

  test("a 404 reports already-revoked and does NOT retry", async () => {
    const h = await harness(() => jsonResponse(404, { title: "not found" }), {
      promptRevokeName: async (name) => name,
    });
    await revokeSubUser(h.deps, PRINCIPAL_NODE);
    assert.strictEqual(h.calls.length, 1, "no retry of a delete");
    assert.ok(h.infos.some((m) => /already revoked or never existed/.test(m)));
    assert.deepStrictEqual(h.errors, []);
  });
});

suite("principal metadata — admin metadata only", () => {
  test("content-shaped fields on the wire are DROPPED by the total mapping", () => {
    const meta = toAdminMetadata({
      id: "sub-1",
      display_name: "alice",
      created_at: "2026-09-01T00:00:00Z",
      oidc_issuer: "https://issuer.example",
      // A misbehaving operator response trying to smuggle content:
      content: "secret text",
      messages: [{ body: "hello" }],
      blocks: "AAAA",
      conversation: { id: "c1" },
    });
    const keys = Object.keys(meta);
    for (const forbidden of [
      "content",
      "message",
      "messages",
      "blocks",
      "body",
      "text",
      "plaintext",
      "ciphertext",
      "conversation",
      "conversations",
    ]) {
      assert.ok(!keys.includes(forbidden), `${forbidden} must be dropped`);
    }
    const rendered = metadataLines(meta).join("\n");
    assert.ok(!rendered.includes("secret text"));
    assert.ok(!rendered.includes("hello"));
    assert.match(rendered, /displayName: alice/);
    assert.match(rendered, /metadata only, read-only/);
  });

  test("the metadata view opens through the read-only virtual scheme with mapped scalars only", async () => {
    let opened: string | undefined;
    const h = await harness(
      () =>
        jsonResponse(200, {
          id: "sub-1",
          display_name: "alice",
          created_at: "2026-09-01T00:00:00Z",
          content: "secret text",
        }),
      {},
    );
    await showPrincipalMetadata(h.deps, PRINCIPAL_NODE, async (content) => {
      opened = content;
    });
    assert.ok(opened);
    assert.ok(!opened.includes("secret text"));
    assert.match(opened, /displayName: alice/);
  });
});

suite("OIDC bind — idempotent by design", () => {
  test("binding sends issuer + sub, issuer pre-filled by the caller", async () => {
    const h = await harness(() => jsonResponse(200, {}), {
      promptOidcSub: async (issuer) => {
        assert.strictEqual(issuer, "https://issuer.example");
        return "314159";
      },
    });
    await bindOidcIdentity(h.deps, PRINCIPAL_NODE, "https://issuer.example");
    assert.strictEqual(h.calls.length, 1);
    const body = JSON.parse(h.calls[0].body ?? "{}") as Record<string, string>;
    assert.deepStrictEqual(body, {
      principal_id: "sub-1",
      oidc_issuer: "https://issuer.example",
      oidc_sub: "314159",
    });
    assert.strictEqual(h.errors.length, 0);
  });

  test("binding twice is a no-op reported as success, not an error", async () => {
    let count = 0;
    const h = await harness(
      () => {
        count += 1;
        return count === 1
          ? jsonResponse(200, {})
          : jsonResponse(409, { title: "already bound" });
      },
      { promptOidcSub: async () => "314159" },
    );
    await bindOidcIdentity(h.deps, PRINCIPAL_NODE, "https://issuer.example");
    await bindOidcIdentity(h.deps, PRINCIPAL_NODE, "https://issuer.example");
    assert.strictEqual(h.errors.length, 0, "the repeat surfaced no error");
    assert.strictEqual(h.infos.length, 2, "both binds read as success");
  });
});

suite("principal write actions are view-scoped, absent elsewhere", () => {
  test("all four commands are hidden from the command palette and contributed only inside the Principals view", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
    ) as {
      contributes: {
        menus: {
          commandPalette: Array<{ command: string; when?: string }>;
          "view/title": Array<{ command: string; when?: string }>;
          "view/item/context": Array<{ command: string; when?: string }>;
        };
      };
    };
    const menus = pkg.contributes.menus;
    const palette = new Map(
      menus.commandPalette.map((m) => [m.command, m.when]),
    );
    for (const cmd of [
      "airdress.principals.create",
      "airdress.principals.revoke",
      "airdress.principals.metadata",
      "airdress.principals.bind",
    ]) {
      assert.strictEqual(
        palette.get(cmd),
        "false",
        `${cmd} must not be reachable from the palette — the Principals view (absent for non-owners) is its only home`,
      );
    }
    for (const entry of [
      ...menus["view/title"],
      ...menus["view/item/context"],
    ].filter((m) => m.command.startsWith("airdress.principals."))) {
      assert.match(String(entry.when), /view == airdress\.principals/);
    }
  });
});
