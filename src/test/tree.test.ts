import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type * as vscodeTypes from "vscode";
import * as vscode from "vscode";
import { ResourceTreeProvider } from "../tree/provider";
import type { PrincipalMeta, TreeFetchers, TreeNodeData } from "../tree/nodes";
import { ProfileStore } from "../profiles/store";
import type { Profile } from "../profiles/model";

/* ------------------------------------------------------------------ *
 * SPEC-042 boundary: enforced in the TYPE, verified at compile time.
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
    ...overrides,
  };
}

async function storeWith(profile: Profile): Promise<ProfileStore> {
  const store = new ProfileStore(new FakeMemento());
  await store.add(profile);
  return store;
}

function sections(children: TreeNodeData[]): string[] {
  return children.map((c) => (c.type === "section" ? c.section : c.type));
}

suite("resource tree (T6-06)", () => {
  test("roots are profiles; expansion yields kinds/principals/enrollments for owners", async () => {
    const provider = new ResourceTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers(),
    );
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].type, "profile");
    const children = await provider.getChildren(roots[0]);
    assert.deepStrictEqual(sections(children), [
      "kinds",
      "principals",
      "enrollments",
    ]);
  });

  test("the Principals branch is ABSENT for non-owners — not present-and-403", async () => {
    const provider = new ResourceTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers({ listPrincipals: async () => "forbidden" }),
    );
    const [profile] = await provider.getChildren();
    const children = await provider.getChildren(profile);
    assert.deepStrictEqual(sections(children), ["kinds", "enrollments"]);
    assert.ok(
      !children.some((c) => c.type === "section" && c.section === "principals"),
    );
  });

  test("kinds without a bundled schema are marked unknown, validation disabled", async () => {
    const provider = new ResourceTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers(),
    );
    const [profile] = await provider.getChildren();
    const children = await provider.getChildren(profile);
    const kindsSection = children.find(
      (c) => c.type === "section" && c.section === "kinds",
    );
    assert.ok(kindsSection);
    const kinds = await provider.getChildren(kindsSection);
    const known = kinds.find(
      (k) => k.type === "kind" && k.kind === "InferencePoolMember",
    );
    const unknown = kinds.find(
      (k) => k.type === "kind" && k.kind === "MysteryKind",
    );
    assert.ok(known && known.type === "kind" && known.known);
    assert.ok(unknown && unknown.type === "kind" && !unknown.known);
    const unknownItem = provider.getTreeItem(unknown);
    assert.strictEqual(unknownItem.description, "unknown, validation disabled");
  });

  test("resources open the read-only virtual doc — never a write action", async () => {
    const provider = new ResourceTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers(),
    );
    const [profile] = await provider.getChildren();
    const children = await provider.getChildren(profile);
    const kindsSection = children.find(
      (c) => c.type === "section" && c.section === "kinds",
    );
    const [kind] = await provider.getChildren(kindsSection);
    const [resource] = await provider.getChildren(kind);
    assert.strictEqual(resource.type, "resource");
    const item = provider.getTreeItem(resource);
    assert.strictEqual(item.command?.command, "airdress.resources.open");
  });

  test("principal tree items expose metadata only and carry no write context", async () => {
    const provider = new ResourceTreeProvider(
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
    // No contextValue → no when-clause menu (create/revoke is SPEC-058).
    assert.strictEqual(item.contextValue, undefined);
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

  test("an unreachable operator yields an error node; the profile node stays", async () => {
    const provider = new ResourceTreeProvider(
      await storeWith(OWNER_PROFILE),
      fetchers({
        listPrincipals: async () => {
          throw new Error("operator unreachable");
        },
      }),
    );
    const [profile] = await provider.getChildren();
    const children = await provider.getChildren(profile);
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].type, "message");
    // Root still lists the profile — no silent switch (design §9).
    const roots = await provider.getChildren();
    assert.strictEqual(roots.length, 1);
  });

  test("no create/revoke command is contributed for principals (SPEC-058 scope)", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
    ) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus?: Record<string, unknown>;
      };
    };
    for (const cmd of pkg.contributes.commands) {
      assert.ok(
        !/principal|sub-?user/i.test(cmd.command + " " + cmd.title),
        `no principal write action may be contributed: ${cmd.command}`,
      );
    }
  });
});
