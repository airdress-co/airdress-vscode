import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type * as vscodeTypes from "vscode";
import * as vscode from "vscode";
import {
  OperatorsTreeProvider,
  PrincipalsTreeProvider,
  ResourcesTreeProvider,
} from "../tree/provider";
import { OwnershipTracker } from "../tree/ownership";
import { decodeKinds } from "../tree/fetchers";
import type { PrincipalMeta, TreeFetchers, TreeNodeData } from "../tree/nodes";
import { ProfileStore } from "../profiles/store";
import type { Profile } from "../profiles/model";

/* ------------------------------------------------------------------ *
 * sub-user isolation boundary: enforced in the TYPE, verified at compile time.
 * If PrincipalMeta ever grows a field capable of holding message
 * content, these lines stop compiling.
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
type PrincipalValueTypes = Exclude<PrincipalMeta[keyof PrincipalMeta], never>;
// 1) No content-ish key may map to a usable (non-never/undefined) value:
type ContentFieldValues = Exclude<
  PrincipalMeta[Extract<keyof PrincipalMeta, ContentKeys>],
  undefined
>;
export type PrincipalHasNoContentFields = AssertNever<ContentFieldValues>;
// 2) Every real field is a plain string — no object graph a lazy loader
//    could hang message content off:
type NonStringValues = Exclude<PrincipalValueTypes, string | undefined>;
export type PrincipalFieldsAreScalars = AssertNever<NonStringValues>;

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

const OWNER_PROFILE: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

const SECOND_PROFILE: Profile = {
  id: "p-second",
  label: "bob",
  fqdn: "bob.a.airdr.es",
  authMode: "bearer",
  dev: false,
};

const PRINCIPAL: PrincipalMeta = {
  id: "5b0c9b3a-0000-0000-0000-000000000001",
  displayName: "alice",
  createdAt: "2026-09-01T00:00:00Z",
};

function fetchers(overrides?: Partial<TreeFetchers>): TreeFetchers {
  return {
    listKinds: async () => ["InferencePoolMember", "MysteryKind"],
    listResources: async (_p, kind) => [{ kind, name: "member-a" }],
    listPrincipals: async () => [PRINCIPAL],
    listEnrollments: async () => [
      { id: "e1", createdAt: "2026-09-01T00:00:00Z" },
    ],
    getStatus: async () => ({ ready: true, state: "Ready" }),
    ...overrides,
  };
}

async function storeWith(...profiles: Profile[]): Promise<ProfileStore> {
  const store = new ProfileStore(new FakeMemento());
  for (const profile of profiles) {
    await store.add(profile);
  }
  await store.setActive(profiles[0]?.id);
  return store;
}

suite("operators view", () => {
  test("lists every profile with the active marker and sign-in state", async () => {
    const store = await storeWith(OWNER_PROFILE, SECOND_PROFILE);
    const provider = new OperatorsTreeProvider(
      store,
      async (node) => node.profile.id === OWNER_PROFILE.id,
    );
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 2);
    const ada = roots.find(
      (r) => r.type === "profile" && r.profile.id === OWNER_PROFILE.id,
    );
    const bob = roots.find(
      (r) => r.type === "profile" && r.profile.id === SECOND_PROFILE.id,
    );
    assert.ok(ada?.type === "profile" && bob?.type === "profile");
    assert.strictEqual(ada.active, true);
    assert.strictEqual(bob.active, false);
    assert.strictEqual(ada.signedIn, true);
    assert.strictEqual(bob.signedIn, false);
    const bobItem = provider.getTreeItem(bob);
    assert.match(String(bobItem.description), /no credential/);
  });

  test("clicking a profile routes to the activate command (no ambient default)", async () => {
    const store = await storeWith(OWNER_PROFILE);
    const provider = new OperatorsTreeProvider(store);
    const [node] = await provider.getChildren();
    const item = provider.getTreeItem(node);
    assert.strictEqual(item.command?.command, "airdress.profiles.activate");
  });
});

suite("resources view (active profile scoped)", () => {
  test("roots are kinds plus the enrollments section; kinds expand to resources", async () => {
    const provider = new ResourcesTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers(),
    );
    const roots = await provider.getChildren();
    const kinds = roots.filter((r) => r.type === "kind");
    assert.strictEqual(kinds.length, 2);
    const enrollments = roots.find(
      (r) => r.type === "section" && r.section === "enrollments",
    );
    assert.ok(enrollments, "enrollments listing survives the view split");
    const [resource] = await provider.getChildren(kinds[0]);
    assert.strictEqual(resource.type, "resource");
    const item = provider.getTreeItem(resource);
    assert.strictEqual(item.command?.command, "airdress.resources.open");
  });

  test("kinds without a bundled schema are marked unknown, validation disabled", async () => {
    const provider = new ResourcesTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers(),
    );
    const roots = await provider.getChildren();
    const unknown = roots.find(
      (k) => k.type === "kind" && k.kind === "MysteryKind",
    );
    assert.ok(unknown && unknown.type === "kind" && !unknown.known);
    const unknownItem = provider.getTreeItem(unknown);
    assert.strictEqual(unknownItem.description, "unknown, validation disabled");
  });

  test("no active profile renders a pointer message, not an error", async () => {
    const store = await storeWith(OWNER_PROFILE);
    await store.setActive(undefined);
    const provider = new ResourcesTreeProvider(store, fetchers());
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].type, "message");
  });

  test("an unreachable operator yields an error node; nothing is dropped silently", async () => {
    const provider = new ResourcesTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers({
        listKinds: async () => {
          throw new Error("operator unreachable");
        },
      }),
    );
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].type, "message");
    assert.match(
      roots[0].type === "message" ? roots[0].text : "",
      /unreachable/,
    );
  });

  test("an unrecognized response shape renders a friendly node — never [object Object] or a TypeError", async () => {
    const provider = new ResourcesTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers({
        // What a decoder throws for a body neither the contract nor a
        // known-live operator sends.
        listKinds: async () => decodeKinds({ kinds: [{ surprise: true }] }),
      }),
    );
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].type, "message");
    const text = roots[0].type === "message" ? roots[0].text : "";
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.doesNotMatch(text, /TypeError|Cannot read properties/);
    assert.match(text, /Unrecognized response/);
    const item = provider.getTreeItem(roots[0]);
    assert.doesNotMatch(String(item.label), /\[object Object\]/);
  });
});

suite("principals view (owner only)", () => {
  test("lists principals of the active profile for an owner", async () => {
    const provider = new PrincipalsTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers(),
    );
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].type, "principal");
  });

  test("forbidden yields an empty view — defence in depth behind the hidden view", async () => {
    const provider = new PrincipalsTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers({ listPrincipals: async () => "forbidden" }),
    );
    const roots = await provider.getChildren();
    assert.deepStrictEqual(roots, []);
  });

  test("the view itself is contributed behind the ownership context key — absent for non-owners", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
    ) as {
      contributes: {
        views: Record<string, Array<{ id: string; when?: string }>>;
      };
    };
    const views = pkg.contributes.views.airdress;
    const ids = views.map((v) => v.id);
    assert.deepStrictEqual(ids, [
      "airdress.operators",
      "airdress.resources",
      "airdress.principals",
    ]);
    const principals = views.find((v) => v.id === "airdress.principals");
    assert.strictEqual(principals?.when, "airdress.principalsAvailable");
  });

  test("principal tree items expose metadata only", async () => {
    const provider = new PrincipalsTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers(),
    );
    const node: TreeNodeData = {
      type: "principal",
      profile: OWNER_PROFILE,
      principal: PRINCIPAL,
    };
    const item = provider.getTreeItem(node);
    assert.strictEqual(
      item.collapsibleState,
      vscode.TreeItemCollapsibleState.None,
    );
    assert.match(String(item.description), /metadata only/);
  });

  test("runtime shape of PrincipalMeta matches the type-level boundary", () => {
    const keys = Object.keys(PRINCIPAL);
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
      assert.ok(
        !keys.includes(forbidden),
        `PrincipalMeta must not carry ${forbidden}`,
      );
    }
  });
});

suite("ownership tracker", () => {
  test("caches the probe result per profile", async () => {
    let calls = 0;
    const tracker = new OwnershipTracker(async () => {
      calls += 1;
      return [PRINCIPAL];
    });
    assert.strictEqual(await tracker.isOwner(OWNER_PROFILE), true);
    assert.strictEqual(await tracker.isOwner(OWNER_PROFILE), true);
    assert.strictEqual(calls, 1);
    tracker.invalidate(OWNER_PROFILE.id);
    await tracker.isOwner(OWNER_PROFILE);
    assert.strictEqual(calls, 2);
  });

  test("forbidden means non-owner and is cached", async () => {
    const tracker = new OwnershipTracker(async () => "forbidden");
    assert.strictEqual(await tracker.isOwner(OWNER_PROFILE), false);
    assert.strictEqual(tracker.known(OWNER_PROFILE.id), false);
  });

  test("an unreachable operator hides the view but is NOT cached as non-owner", async () => {
    let calls = 0;
    const tracker = new OwnershipTracker(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("unreachable");
      }
      return [PRINCIPAL];
    });
    assert.strictEqual(await tracker.isOwner(OWNER_PROFILE), false);
    assert.strictEqual(tracker.known(OWNER_PROFILE.id), undefined);
    assert.strictEqual(await tracker.isOwner(OWNER_PROFILE), true);
  });
});
