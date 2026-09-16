import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type * as vscodeTypes from "vscode";
import {
  revokeEnrollment,
  type EnrollmentRevokeDeps,
  type EnrollmentRevokeUI,
} from "../enrollments/revoke";
import { ProfileStore } from "../profiles/store";
import { AuthManager } from "../auth/manager";
import { SecretStore } from "../auth/store";
import { LiveManifestProvider } from "../manifests/virtual";
import type { ManifestDeps } from "../manifests/diff";
import type { Profile } from "../profiles/model";
import type { TreeNodeData } from "../tree/nodes";
import { ResourcesTreeProvider } from "../tree/provider";

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

const NODE: TreeNodeData = {
  type: "enrollment",
  profile: OWNER,
  enrollment: {
    id: "6f1c2a8e-0d4b-4c43-9a51-2f7d8e9b0c11",
    createdAt: "2026-09-01T00:00:00Z",
    deviceLabel: "dead phone",
    airdress: "ada.a.airdr.es",
  },
};

interface Call {
  url: string;
  method: string;
}

interface Harness {
  deps: EnrollmentRevokeDeps;
  calls: Call[];
  infos: string[];
  errors: string[];
  refreshes: () => number;
}

async function harness(
  respond: (call: Call) => Response,
  ui: Partial<EnrollmentRevokeUI>,
): Promise<Harness> {
  const calls: Call[] = [];
  const auth = new AuthManager(new SecretStore(new FakeSecretStorage()));
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
      };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  };
  const infos: string[] = [];
  const errors: string[] = [];
  let refreshCount = 0;
  const deps: EnrollmentRevokeDeps = {
    manifest,
    ui: {
      confirmRevoke: async () => false,
      info: (m) => infos.push(m),
      error: (m) => errors.push(m),
      ...ui,
    },
    refreshResources: () => {
      refreshCount += 1;
    },
  };
  return { deps, calls, infos, errors, refreshes: () => refreshCount };
}

function status(code: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });
}

suite("enrollment revoke — confirmation, request, refresh", () => {
  test("a declined confirmation sends NO request", async () => {
    let asked: string | undefined;
    const h = await harness(() => status(204), {
      confirmRevoke: async (enrollment) => {
        asked = enrollment.deviceLabel;
        return false;
      },
    });
    await revokeEnrollment(h.deps, NODE);
    assert.strictEqual(asked, "dead phone", "the dialog was shown the device");
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(h.refreshes(), 0);
  });

  test("a confirmed revoke DELETEs that enrollment once, then refreshes", async () => {
    const h = await harness(() => new Response(null, { status: 204 }), {
      confirmRevoke: async () => true,
    });
    await revokeEnrollment(h.deps, NODE);
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].method, "DELETE");
    assert.match(
      h.calls[0].url,
      /\/v1\/endpoints\/enrollments\/6f1c2a8e-0d4b-4c43-9a51-2f7d8e9b0c11$/,
    );
    assert.deepStrictEqual(h.errors, []);
    assert.ok(
      h.infos.some((m) => /'dead phone'.*revoked on ada\.a\.airdr\.es/.test(m)),
      h.infos.join("\n"),
    );
    assert.strictEqual(h.refreshes(), 1);
  });

  test("a 404 reports already-revoked, does NOT retry, and still refreshes", async () => {
    const h = await harness(() => status(404, { title: "not found" }), {
      confirmRevoke: async () => true,
    });
    await revokeEnrollment(h.deps, NODE);
    assert.strictEqual(h.calls.length, 1, "no retry of a delete");
    assert.ok(h.infos.some((m) => /already revoked or never existed/.test(m)));
    assert.deepStrictEqual(h.errors, []);
    assert.strictEqual(h.refreshes(), 1);
  });

  test("a 403 is reported as the operator's refusal for this sign-in", async () => {
    const h = await harness(() => status(403, { title: "forbidden" }), {
      confirmRevoke: async () => true,
    });
    await revokeEnrollment(h.deps, NODE);
    assert.strictEqual(h.errors.length, 1);
    assert.match(h.errors[0], /refused to revoke 'dead phone'/);
    assert.strictEqual(h.refreshes(), 1);
  });

  test("a node that is not an enrollment does nothing", async () => {
    const h = await harness(() => status(204), {
      confirmRevoke: async () => true,
    });
    await revokeEnrollment(h.deps, { type: "message", text: "x" });
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(h.refreshes(), 0);
  });
});

suite("enrollment revoke — where it is offered", () => {
  test("an enrollment row carries the context value the menu keys on", async () => {
    const store = new ProfileStore(new FakeMemento());
    await store.add(OWNER);
    await store.setActive(OWNER.id);
    const provider = new ResourcesTreeProvider(store, {
      listKinds: async () => [],
      listResources: async () => [],
      listPrincipals: async () => [],
      listEnrollments: async () => [],
      getStatus: async () => ({ ready: true, state: "Ready" }),
    });
    const item = provider.getTreeItem(NODE);
    assert.strictEqual(item.contextValue, "airdressEnrollment");
    assert.match(String(item.tooltip), /label: dead phone/);
  });

  test("the command is hidden from the palette and offered only on enrollment rows", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
    ) as {
      contributes: {
        menus: {
          commandPalette: Array<{ command: string; when?: string }>;
          "view/item/context": Array<{ command: string; when?: string }>;
        };
      };
    };
    const menus = pkg.contributes.menus;
    const palette = menus.commandPalette.find(
      (m) => m.command === "airdress.enrollments.revoke",
    );
    assert.strictEqual(palette?.when, "false");
    const rows = menus["view/item/context"].filter(
      (m) => m.command === "airdress.enrollments.revoke",
    );
    assert.deepStrictEqual(
      rows.map((m) => m.when),
      ["view == airdress.resources && viewItem == airdressEnrollment"],
    );
  });
});
