import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  collectAirdresses,
  connectAirdress,
  DISCOVERY_CAP,
  discoveryUnavailableMessage,
  HubDiscoveryError,
  hubPageFetcher,
  parseHubEntry,
  parseHubPage,
  type ConnectDeps,
  type ConnectUI,
  type HubAirdress,
  type HubPage,
} from "../profiles/connect";
import { ProfileStore } from "../profiles/store";

/** First-contact UX: contributions, hub parsing, explicit degradation. */

function readPackageJson(): {
  contributes: {
    viewsContainers: { activitybar: Array<{ id: string; icon: string }> };
    viewsWelcome?: Array<{ view: string; contents: string }>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
    commands: Array<{ command: string; title: string; icon?: string }>;
  };
} {
  const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
  assert.ok(ext, "extension not found");
  return JSON.parse(
    fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
  );
}

suite("first-contact contributions", () => {
  test("the view container uses the brand mark, and the file ships", () => {
    const pkg = readPackageJson();
    const container = pkg.contributes.viewsContainers.activitybar.find(
      (c) => c.id === "airdress",
    );
    assert.strictEqual(container?.icon, "media/sidebar-mark-mono.svg");
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    const svg = fs.readFileSync(
      path.join(ext.extensionPath, "media", "sidebar-mark-mono.svg"),
      "utf8",
    );
    assert.match(svg, /^<svg /, "icon must be an SVG");
  });

  test("the Operators view welcomes an empty state with the connect flow", () => {
    const pkg = readPackageJson();
    const welcome = pkg.contributes.viewsWelcome?.find(
      (w) => w.view === "airdress.operators",
    );
    assert.ok(welcome, "no viewsWelcome for airdress.operators");
    assert.match(
      welcome.contents,
      /\[Connect an Airdress\]\(command:airdress\.connectAirdress\)/,
      "welcome must link the connect command as a button",
    );
    // The manual path stays reachable from the same empty state.
    assert.match(
      welcome.contents,
      /command:airdress\.profiles\.add/,
      "welcome must keep the manual add path",
    );
  });

  test("a + title action on the Operators view runs the connect flow", () => {
    const pkg = readPackageJson();
    const entry = pkg.contributes.menus["view/title"].find(
      (m) => m.command === "airdress.connectAirdress",
    );
    assert.ok(entry, "no view/title menu entry for the connect command");
    assert.strictEqual(entry.when, "view == airdress.operators");
    const command = pkg.contributes.commands.find(
      (c) => c.command === "airdress.connectAirdress",
    );
    assert.strictEqual(command?.icon, "$(add)");
  });

  test("the palette command for manual profile creation remains", () => {
    const pkg = readPackageJson();
    assert.ok(
      pkg.contributes.commands.some(
        (c) => c.command === "airdress.profiles.add",
      ),
    );
  });
});

suite("hub response parsing", () => {
  test("prefers the response's own fqdn field over construction", () => {
    const entry = parseHubEntry({
      id: "019e2b8c-2474-7671-a5da-6786ec715fd3",
      name: "ada",
      fqdn: "ada.custom.example.com",
      dns_status: "active",
    });
    assert.deepStrictEqual(entry, {
      name: "ada",
      fqdn: "ada.custom.example.com",
      dnsStatus: "active",
    });
  });

  test("constructs <id>.a.airdr.es only when no fqdn is returned", () => {
    const entry = parseHubEntry({
      id: "019e2b8c-2474-7671-a5da-6786ec715fd3",
      name: "ada",
      dns_status: "pending",
    });
    assert.strictEqual(
      entry?.fqdn,
      "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es",
    );
    assert.strictEqual(entry.dnsStatus, "pending");
  });

  test("skips entries that yield no valid hostname", () => {
    assert.strictEqual(parseHubEntry(null), undefined);
    assert.strictEqual(parseHubEntry("ada"), undefined);
    assert.strictEqual(parseHubEntry({ id: "x" }), undefined);
    assert.strictEqual(parseHubEntry({ name: "ada" }), undefined);
    // A raw IP in an fqdn field fails the same validation as manual entry.
    assert.strictEqual(
      parseHubEntry({ name: "ada", fqdn: "185.43.32.11" }),
      undefined,
    );
    assert.strictEqual(
      parseHubEntry({ name: "ada", fqdn: "not a hostname" }),
      undefined,
    );
  });

  test("accepts a bare array and the conventional wrapper keys", () => {
    const item = { name: "ada", fqdn: "ada.a.airdr.es" };
    assert.strictEqual(parseHubPage([item]).entries.length, 1);
    for (const key of ["airdresses", "items", "data", "results"]) {
      const page = parseHubPage({ [key]: [item], next_cursor: "c1" });
      assert.strictEqual(page.entries.length, 1, key);
      assert.strictEqual(page.nextCursor, "c1", key);
    }
  });

  test("a malformed body is an error, never an empty success", () => {
    for (const body of [null, 42, "nope", {}, { airdresses: "x" }]) {
      assert.throws(
        () => parseHubPage(body),
        (err: unknown) =>
          err instanceof HubDiscoveryError && err.reason === "malformed",
        `expected malformed for ${JSON.stringify(body)}`,
      );
    }
  });

  test("malformed entries inside a well-formed page are skipped", () => {
    const page = parseHubPage([
      { name: "ada", fqdn: "ada.a.airdr.es" },
      { bogus: true },
      null,
    ]);
    assert.deepStrictEqual(
      page.entries.map((e) => e.name),
      ["ada"],
    );
  });
});

suite("hub pagination", () => {
  const entry = (n: number): HubAirdress => ({
    name: `op-${n}`,
    fqdn: `op-${n}.a.airdr.es`,
  });

  test("follows cursors and concatenates pages", async () => {
    const pages: Record<string, HubPage> = {
      start: { entries: [entry(1), entry(2)], nextCursor: "c1" },
      c1: { entries: [entry(3)], nextCursor: "c2" },
      c2: { entries: [entry(4)] },
    };
    const requested: Array<string | undefined> = [];
    const all = await collectAirdresses(async (cursor) => {
      requested.push(cursor);
      return pages[cursor ?? "start"];
    });
    assert.deepStrictEqual(requested, [undefined, "c1", "c2"]);
    assert.strictEqual(all.length, 4);
  });

  test("caps collection at the discovery limit", async () => {
    let calls = 0;
    const all = await collectAirdresses(async () => {
      calls++;
      return {
        entries: Array.from({ length: 60 }, (_, i) => entry(calls * 1000 + i)),
        nextCursor: `c${calls}`,
      };
    });
    assert.strictEqual(all.length, DISCOVERY_CAP);
    assert.ok(calls <= 4, `cap must stop fetching (made ${calls} calls)`);
  });

  test("a repeated cursor stops the walk — never a loop", async () => {
    let calls = 0;
    const all = await collectAirdresses(async () => {
      calls++;
      return {
        entries: [entry(calls)],
        nextCursor: "same-cursor-forever",
      };
    });
    assert.strictEqual(calls, 2, "one follow of the cursor, then stop");
    assert.strictEqual(all.length, 2);
  });

  test("deduplicates by FQDN across pages", async () => {
    const pages: Record<string, HubPage> = {
      start: { entries: [entry(1)], nextCursor: "c1" },
      c1: { entries: [entry(1), entry(2)] },
    };
    const all = await collectAirdresses(
      async (cursor) => pages[cursor ?? "start"],
    );
    assert.strictEqual(all.length, 2);
  });
});

suite("hub page fetcher", () => {
  const okResponse = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;

  test("401 and 403 map to unauthorized with the status kept", async () => {
    for (const status of [401, 403]) {
      const fetchPage = hubPageFetcher(
        "https://account.airdress.co",
        "token",
        async () => okResponse({}, status),
      );
      await assert.rejects(
        fetchPage(),
        (err: unknown) =>
          err instanceof HubDiscoveryError &&
          err.reason === "unauthorized" &&
          err.httpStatus === status,
      );
    }
  });

  test("a network failure maps to unreachable", async () => {
    const fetchPage = hubPageFetcher(
      "https://account.airdress.co",
      "token",
      async () => {
        throw new TypeError("fetch failed");
      },
    );
    await assert.rejects(
      fetchPage(),
      (err: unknown) =>
        err instanceof HubDiscoveryError && err.reason === "unreachable",
    );
  });

  test("requests the list endpoint and threads the cursor", async () => {
    const urls: string[] = [];
    const fetchPage = hubPageFetcher(
      "https://account.airdress.co",
      "token",
      async (input) => {
        urls.push(String(input));
        return okResponse([]);
      },
    );
    await fetchPage();
    await fetchPage("abc");
    assert.strictEqual(urls[0], "https://account.airdress.co/api/airdresses");
    assert.strictEqual(
      urls[1],
      "https://account.airdress.co/api/airdresses?cursor=abc",
    );
  });
});

suite("explicit degradation", () => {
  test("the message always names the hub and the reason", () => {
    const hub = "https://account.airdress.co";
    const unauthorized = discoveryUnavailableMessage(
      hub,
      new HubDiscoveryError("unauthorized", 401),
    );
    assert.match(unauthorized, /HTTP 401/);
    assert.match(unauthorized, /account\.airdress\.co/);
    assert.match(unauthorized, /hostname/);
    const unreachable = discoveryUnavailableMessage(
      hub,
      new HubDiscoveryError("unreachable"),
    );
    assert.match(unreachable, /could not be reached/);
    const malformed = discoveryUnavailableMessage(
      hub,
      new HubDiscoveryError("malformed"),
    );
    assert.match(malformed, /does not understand/);
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

interface FlowLog {
  discarded: string[];
  manualOffered: string[];
  manualRan: number;
  errors: string[];
  focused: number;
}

function flowHarness(overrides: {
  fetchFn?: typeof fetch;
  signIn?: (id: string) => Promise<void>;
  pick?: ConnectUI["pick"];
  acceptManual?: boolean;
}): { deps: ConnectDeps; store: ProfileStore; log: FlowLog } {
  const store = new ProfileStore(new FakeMemento());
  const log: FlowLog = {
    discarded: [],
    manualOffered: [],
    manualRan: 0,
    errors: [],
    focused: 0,
  };
  const deps: ConnectDeps = {
    profiles: store,
    signIn: overrides.signIn ?? (async () => {}),
    getToken: async () => "an-access-token",
    discard: async (id) => {
      log.discarded.push(id);
    },
    hubUrl: () => "https://account.airdress.co",
    fetchFn: overrides.fetchFn,
    ui: {
      pick: overrides.pick ?? (async () => undefined),
      offerManualEntry: async (message) => {
        log.manualOffered.push(message);
        return overrides.acceptManual ?? false;
      },
      addProfileManually: async () => {
        log.manualRan++;
      },
      info: () => {},
      error: (message) => {
        log.errors.push(message);
      },
      focusOperatorsView: async () => {
        log.focused++;
      },
    },
  };
  return { deps, store, log };
}

suite("connect flow", () => {
  const reject = (status: number): typeof fetch =>
    (async () =>
      ({
        ok: false,
        status,
        json: async () => ({}),
      }) as unknown as Response) as typeof fetch;

  test("401 from the hub offers manual entry and creates nothing", async () => {
    const { deps, store, log } = flowHarness({
      fetchFn: reject(401),
      acceptManual: true,
    });
    await connectAirdress(deps);
    assert.strictEqual(store.list().length, 0, "no profile may be created");
    assert.strictEqual(store.activeId(), undefined, "no ambient default");
    assert.strictEqual(log.manualOffered.length, 1, "exactly one offer");
    assert.match(log.manualOffered[0], /HTTP 401/);
    assert.strictEqual(log.manualRan, 1, "manual path runs when accepted");
    assert.strictEqual(log.discarded.length, 1, "credential is dropped");
  });

  test("an unreachable hub degrades once — no retry loop", async () => {
    let attempts = 0;
    const { deps, store, log } = flowHarness({
      fetchFn: (async () => {
        attempts++;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await connectAirdress(deps);
    assert.strictEqual(attempts, 1, "exactly one request, never a retry loop");
    assert.strictEqual(log.manualOffered.length, 1);
    assert.match(log.manualOffered[0], /could not be reached/);
    assert.strictEqual(log.manualRan, 0, "declined offer runs nothing");
    assert.strictEqual(store.list().length, 0);
  });

  test("picking a name creates the profile and focuses the view", async () => {
    const body = [
      {
        id: "019e2b8c-2474-7671-a5da-6786ec715fd3",
        name: "ada",
        dns_status: "active",
      },
    ];
    const { deps, store, log } = flowHarness({
      fetchFn: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => body,
        }) as unknown as Response) as typeof fetch,
      pick: async (entries) => entries[0],
    });
    await connectAirdress(deps);
    const profiles = store.list();
    assert.strictEqual(profiles.length, 1);
    assert.strictEqual(profiles[0].label, "ada");
    assert.strictEqual(
      profiles[0].fqdn,
      "019e2b8c-2474-7671-a5da-6786ec715fd3.a.airdr.es",
    );
    assert.strictEqual(profiles[0].authMode, "zitadel");
    assert.strictEqual(store.activeId(), profiles[0].id);
    assert.strictEqual(log.focused, 1, "Operators view is focused");
    assert.strictEqual(log.discarded.length, 0, "credential stays bound");
  });

  test("cancelling the picker discards the credential and creates nothing", async () => {
    const { deps, store, log } = flowHarness({
      fetchFn: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [{ name: "ada", fqdn: "ada.a.airdr.es" }],
        }) as unknown as Response) as typeof fetch,
      pick: async () => undefined,
    });
    await connectAirdress(deps);
    assert.strictEqual(store.list().length, 0);
    assert.strictEqual(log.discarded.length, 1);
  });

  test("a failed sign-in surfaces an error and touches nothing else", async () => {
    let fetched = 0;
    const { deps, store, log } = flowHarness({
      signIn: async () => {
        throw new Error("Authorization failed: access_denied");
      },
      fetchFn: (async () => {
        fetched++;
        throw new Error("must not be called");
      }) as typeof fetch,
    });
    await connectAirdress(deps);
    assert.strictEqual(fetched, 0, "no hub request without a sign-in");
    assert.strictEqual(log.errors.length, 1);
    assert.strictEqual(store.list().length, 0);
    assert.strictEqual(log.discarded.length, 1);
  });
});
