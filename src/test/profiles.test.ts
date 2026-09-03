import * as assert from "assert";
import type * as vscode from "vscode";
import { isLocalhost, validateFqdn } from "../profiles/validate";
import { statusBarText } from "../profiles/picker";
import { ProfileStore } from "../profiles/store";
import type { Profile } from "../profiles/model";

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
    "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es", // SPEC-029 form
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
