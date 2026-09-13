import * as assert from "assert";
import type * as vscode from "vscode";
import { isLocalhost, validateFqdn } from "../profiles/validate";
import { pickProfile, resolveProfile, statusBarText } from "../profiles/picker";
import { DuplicateFqdnError, ProfileStore } from "../profiles/store";
import type { Profile } from "../profiles/model";
import { explicitProfile } from "../extension";

/**
 * Table-driven FQDN validation (FR-25). Raw IP literals bypass the
 * relay TLS path — this is a project-wide rule and gets a test, not a
 * comment.
 */
suite("FQDN validation table (T6-03)", () => {
  const rejected: Array<[string, RegExp]> = [
    // The four inputs the spec names explicitly:
    ["185.43.32.11", /IPv4/],
    ["[2a14:ae00:101::1]", /IPv6/],
    ["2a14:ae00:101::1", /Colons/],
    ["http://ada.a.airdr.es", /not a URL/],
    // And their near neighbours:
    ["https://ada.a.airdr.es", /not a URL/],
    ["ada.a.airdr.es/path", /not a URL/],
    ["ada.a.airdr.es:8443", /Colons/],
    ["127.0.0.1", /IPv4/],
    ["::1", /Colons/],
    ["[::1]", /IPv6/],
    ["", /hostname/],
    ["   ", /hostname/],
    ["ada", /fully-qualified/],
    ["-bad-.a.airdr.es", /valid hostname/],
  ];

  for (const [input, message] of rejected) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      const err = validateFqdn(input, { allowLocalhost: false });
      assert.ok(err, `expected rejection for ${JSON.stringify(input)}`);
      assert.match(err, message);
      // Dev mode must not soften anything except localhost:
      assert.ok(
        validateFqdn(input, { allowLocalhost: true }),
        `dev mode must not accept ${JSON.stringify(input)}`,
      );
    });
  }

  const accepted = [
    "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es", // canonical airdress name form
    "ada.a.airdr.es",
    "canary.a.airdr.es",
    "operator.example.com",
  ];
  for (const input of accepted) {
    test(`accepts ${input}`, () => {
      assert.strictEqual(
        validateFqdn(input, { allowLocalhost: false }),
        undefined,
      );
    });
  }

  test("localhost is rejected unless the dev setting is on", () => {
    const err = validateFqdn("localhost", { allowLocalhost: false });
    assert.ok(err);
    assert.match(err, /airdress\.dev\.allowLocalhost/);
    assert.strictEqual(
      validateFqdn("localhost", { allowLocalhost: true }),
      undefined,
    );
    assert.strictEqual(
      validateFqdn("  LOCALHOST  ", { allowLocalhost: true }),
      undefined,
    );
  });

  test("isLocalhost identifies the dev form", () => {
    assert.strictEqual(isLocalhost("localhost"), true);
    assert.strictEqual(isLocalhost("ada.a.airdr.es"), false);
  });
});

suite("status bar (T6-03)", () => {
  const base: Profile = {
    id: "p1",
    label: "ada",
    fqdn: "ada.a.airdr.es",
    authMode: "zitadel",
    dev: false,
  };

  test("shows the active profile label", () => {
    assert.strictEqual(statusBarText(base), "$(radio-tower) ada");
  });

  test("shows the dev state for dev profiles", () => {
    assert.strictEqual(
      statusBarText({ ...base, fqdn: "localhost", dev: true }),
      "$(radio-tower) ada (dev)",
    );
  });

  test("shows a no-profile state", () => {
    assert.strictEqual(
      statusBarText(undefined),
      "$(radio-tower) airdress: no profile",
    );
  });
});

class FakeMemento implements vscode.Memento {
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

suite("ProfileStore validation boundary (T6-03)", () => {
  test("an invalid FQDN cannot be persisted even bypassing the UI", async () => {
    const store = new ProfileStore(new FakeMemento());
    await assert.rejects(
      store.add({
        id: "p1",
        label: "raw",
        fqdn: "185.43.32.11",
        authMode: "bearer",
        dev: false,
      }),
      /Invalid profile FQDN/,
    );
    assert.strictEqual(store.list().length, 0);
  });

  test("a localhost profile persists only as a dev profile", async () => {
    const store = new ProfileStore(new FakeMemento());
    // dev:false + no explicit allowLocalhost → rejected.
    await assert.rejects(
      store.add({
        id: "p1",
        label: "local",
        fqdn: "localhost",
        authMode: "bearer",
        dev: false,
      }),
      /allowLocalhost/,
    );
    // dev profile with the setting on → accepted.
    await store.add(
      {
        id: "p2",
        label: "local",
        fqdn: "localhost",
        authMode: "bearer",
        dev: true,
      },
      { allowLocalhost: true },
    );
    assert.strictEqual(store.list().length, 1);
  });

  test("removing the active profile clears the active selection", async () => {
    const store = new ProfileStore(new FakeMemento());
    await store.add({
      id: "p1",
      label: "ada",
      fqdn: "ada.a.airdr.es",
      authMode: "zitadel",
      dev: false,
    });
    await store.setActive("p1");
    await store.remove("p1");
    assert.strictEqual(store.activeId(), undefined);
  });
});

function profile(id: string, fqdn: string, label = id): Profile {
  return { id, label, fqdn, authMode: "zitadel", dev: false };
}

suite("resolveProfile: explicit → active → pick", () => {
  test("an explicit profile wins, even over the active one", async () => {
    const store = new ProfileStore(new FakeMemento());
    const a = profile("a", "a.a.airdr.es");
    const b = profile("b", "b.a.airdr.es");
    await store.add(a);
    await store.add(b);
    await store.setActive(a.id);
    let picks = 0;
    const got = await resolveProfile(store, b, async () => {
      picks += 1;
      return a;
    });
    assert.strictEqual(got?.id, "b");
    assert.strictEqual(picks, 0);
  });

  test("the active profile is the standing target — no pick", async () => {
    const store = new ProfileStore(new FakeMemento());
    const a = profile("a", "a.a.airdr.es");
    const b = profile("b", "b.a.airdr.es");
    await store.add(a);
    await store.add(b);
    await store.setActive(b.id);
    let picks = 0;
    const got = await resolveProfile(store, undefined, async () => {
      picks += 1;
      return a;
    });
    assert.strictEqual(got?.id, "b");
    assert.strictEqual(picks, 0, "nothing asked while an airdress is active");
  });

  test("with nothing active the pick returns, pre-selecting nothing", async () => {
    const store = new ProfileStore(new FakeMemento());
    const a = profile("a", "a.a.airdr.es");
    await store.add(a);
    await store.setActive(undefined);
    let seen: string | undefined = "unset";
    const got = await resolveProfile(store, undefined, async (all, active) => {
      seen = active;
      return all[0];
    });
    assert.strictEqual(got?.id, "a");
    assert.strictEqual(seen, undefined);
  });

  test("an active id whose row is gone falls back to the pick", async () => {
    const store = new ProfileStore(new FakeMemento());
    const a = profile("a", "a.a.airdr.es");
    await store.add(a);
    await store.setActive("ghost");
    let picks = 0;
    await resolveProfile(store, undefined, async (all) => {
      picks += 1;
      return all[0];
    });
    assert.strictEqual(picks, 1);
  });

  test("pickProfile always asks — switching is the one pick left", async () => {
    const store = new ProfileStore(new FakeMemento());
    const a = profile("a", "a.a.airdr.es");
    const b = profile("b", "b.a.airdr.es");
    await store.add(a);
    await store.add(b);
    await store.setActive(a.id);
    await pickProfile(store, async (all, active) => {
      assert.strictEqual(
        active,
        "a",
        "the current one is offered as the pre-selection",
      );
      return all.find((p) => p.id === "b");
    });
    assert.strictEqual(store.activeId(), "b");
  });
});

suite("one row per airdress", () => {
  test("add refuses a second row for an FQDN the store holds, case-insensitively", async () => {
    const store = new ProfileStore(new FakeMemento());
    await store.add(profile("a", "019e2b8c.a.airdr.es"));
    await assert.rejects(
      store.add(profile("b", "019E2B8C.a.airdr.es")),
      (err: unknown) =>
        err instanceof DuplicateFqdnError && err.existing.id === "a",
    );
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.findByFqdn("019e2b8c.A.AIRDR.ES")?.id, "a");
  });

  test("a bearer profile may share an FQDN with the signed-in one — it is another principal", async () => {
    const store = new ProfileStore(new FakeMemento());
    await store.add(profile("owner", "op2.a.airdr.es"));
    await store.add({
      ...profile("sub", "op2.a.airdr.es", "bob"),
      authMode: "bearer",
    });
    await store.add({
      ...profile("sub2", "op2.a.airdr.es", "carol"),
      authMode: "bearer",
    });
    assert.strictEqual(store.list().length, 3);
    assert.strictEqual(store.findByFqdn("op2.a.airdr.es")?.id, "owner");
    const merged = await store.dedupe(
      async () => true,
      async () => {},
    );
    assert.strictEqual(merged.length, 0, "bearer rows never collapse");
    assert.strictEqual(store.list().length, 3);
  });

  test("dedupe keeps the row with a credential, keeps its id, clears the losers, moves the active", async () => {
    const memento = new FakeMemento();
    // Seed twins straight into state, the way the old build left them.
    await memento.update("airdress.profiles", [
      profile("dead", "op2.a.airdr.es", "op2"),
      profile("live", "op2.a.airdr.es", "op2"),
      profile("other", "op1.a.airdr.es", "op1"),
    ]);
    await memento.update("airdress.activeProfileId", "dead");
    const store = new ProfileStore(memento);
    const cleared: string[] = [];
    const merged = await store.dedupe(
      async (p) => p.id === "live",
      async (id) => {
        cleared.push(id);
      },
    );
    assert.deepStrictEqual(
      store.list().map((p) => p.id),
      ["live", "other"],
    );
    assert.strictEqual(store.activeId(), "live");
    assert.deepStrictEqual(cleared, ["dead"]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].kept.id, "live");
    // Idempotent: a second pass merges nothing and clears nothing.
    const again = await store.dedupe(
      async () => true,
      async () => {
        cleared.push("never");
      },
    );
    assert.strictEqual(again.length, 0);
    assert.deepStrictEqual(cleared, ["dead"]);
  });

  test("dedupe with no credentialed row keeps the active one, else the first", async () => {
    const memento = new FakeMemento();
    await memento.update("airdress.profiles", [
      profile("x1", "x.a.airdr.es"),
      profile("x2", "x.a.airdr.es"),
      profile("y1", "y.a.airdr.es"),
      profile("y2", "y.a.airdr.es"),
    ]);
    await memento.update("airdress.activeProfileId", "x2");
    const store = new ProfileStore(memento);
    await store.dedupe(
      async () => false,
      async () => {},
    );
    assert.deepStrictEqual(
      store.list().map((p) => p.id),
      ["x2", "y1"],
    );
    assert.strictEqual(store.activeId(), "x2");
  });
});

suite("explicitProfile: what a command was invoked ON", () => {
  test("a profile row names its profile; a Profile argument is itself; other nodes name nothing", () => {
    const p = profile("a", "a.a.airdr.es");
    assert.strictEqual(explicitProfile(undefined), undefined);
    assert.strictEqual(explicitProfile(p), p);
    assert.strictEqual(
      explicitProfile({ type: "profile", profile: p, active: true }),
      p,
    );
    assert.strictEqual(
      explicitProfile({
        type: "resource",
        profile: p,
        resource: { kind: "Schedule", name: "x" },
      } as never),
      undefined,
    );
  });
});
