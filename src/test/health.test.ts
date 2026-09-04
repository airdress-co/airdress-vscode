import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { correctnessLine, livenessFrom, livenessLine } from "../health/state";
import { StatusCache } from "../health/statusCache";
import { HealthPoller } from "../health/poller";
import { parseResourceStatus } from "../tree/fetchers";
import { OperatorsTreeProvider } from "../tree/provider";
import { ProfileStore } from "../profiles/store";
import type { Profile } from "../profiles/model";
import type * as vscodeTypes from "vscode";

const PROFILE: Profile = {
  id: "p1",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

function profileN(n: number): Profile {
  return {
    id: `p-${n}`,
    label: `op${n}`,
    fqdn: `op${n}.a.airdr.es`,
    authMode: "zitadel",
    dev: false,
  };
}

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite("health state machine — three states, two axes", () => {
  test("an unreachable operator is UNMONITORED — never unhealthy, never healthy", () => {
    const liveness = livenessFrom({ ok: false, at: "12:00:00" });
    assert.strictEqual(liveness.signal, "unmonitored");
    const line = livenessLine(liveness);
    assert.match(line.text, /Unmonitored/);
    // The regression to guard: collapsing three states into a boolean.
    assert.doesNotMatch(line.text, /unhealthy|failing|down|error/i);
    assert.doesNotMatch(line.text, /healthy|ok|up\b/i);
  });

  test("losing reachability carries the last successful response forward", () => {
    const reachable = livenessFrom({ ok: true, latencyMs: 42, at: "11:58:00" });
    assert.strictEqual(reachable.signal, "reachable");
    const lost = livenessFrom({ ok: false, at: "12:00:00" }, reachable);
    assert.ok(lost.signal === "unmonitored");
    assert.strictEqual(lost.lastResponseAt, "11:58:00");
    assert.match(livenessLine(lost).text, /no response since 11:58:00/);
  });

  test("correctness unavailable while liveness is fine renders as partially observed, NAMING the missing signal", () => {
    const cache = new StatusCache();
    const correctness = cache.correctnessFor(PROFILE.id);
    assert.strictEqual(correctness.signal, "unavailable");
    const line = correctnessLine(correctness);
    assert.match(line.text, /Partially observed/);
    assert.match(line.text, /correctness unavailable/);
  });

  test("the two signals render as two separate rows in the Operators view — never one combined dot", async () => {
    const store = new ProfileStore(new FakeMemento());
    await store.add(PROFILE);
    await store.setActive(PROFILE.id);
    const cache = new StatusCache();
    cache.set(PROFILE.id, {
      kind: "Zone",
      name: "a",
      ready: false,
      state: "Pending",
      checkedAt: "12:00:00",
    });
    const provider = new OperatorsTreeProvider(store, undefined, {
      livenessFor: () => ({
        signal: "reachable",
        latencyMs: 42,
        checkedAt: "12:00:00",
      }),
      correctnessFor: (id) => cache.correctnessFor(id),
    });
    const [profileNode] = await provider.getChildren();
    const rows = await provider.getChildren(profileNode);
    assert.strictEqual(rows.length, 2);
    const axes = rows.map((r) => (r.type === "health" ? r.axis : r.type));
    assert.deepStrictEqual(axes, ["liveness", "correctness"]);
    // Liveness reachable + correctness degraded coexist un-merged:
    assert.match(rows[0].type === "health" ? rows[0].text : "", /Reachable/);
    assert.match(rows[1].type === "health" ? rows[1].text : "", /not Ready/);
  });

  test("status cache rolls up all-ready and not-ready with the operator's own words", () => {
    const cache = new StatusCache();
    cache.set(PROFILE.id, {
      kind: "Zone",
      name: "a",
      ready: true,
      state: "Ready",
      checkedAt: "1",
    });
    cache.set(PROFILE.id, {
      kind: "Zone",
      name: "b",
      ready: false,
      state: "Pending",
      checkedAt: "2",
    });
    const c = cache.correctnessFor(PROFILE.id);
    assert.ok(c.signal === "not-ready");
    assert.strictEqual(c.total, 2);
    assert.deepStrictEqual(c.notReady, [
      { kind: "Zone", name: "b", state: "Pending" },
    ]);
  });

  test("defensive status parsing never invents a green checkmark", () => {
    assert.deepStrictEqual(parseResourceStatus({ ready: true }), {
      ready: true,
      state: "Ready",
    });
    assert.deepStrictEqual(parseResourceStatus({ state: "Pending" }), {
      ready: false,
      state: "Pending",
    });
    assert.deepStrictEqual(parseResourceStatus({}), {
      ready: false,
      state: "Unknown",
    });
    assert.deepStrictEqual(parseResourceStatus(undefined), {
      ready: false,
      state: "Unknown",
    });
  });
});

suite("bounded polling", () => {
  test("polls only while visible; hiding the view stops ALL traffic", async () => {
    let requests = 0;
    const poller = new HealthPoller({
      ping: async () => {
        requests += 1;
        return 5;
      },
      intervalMs: () => 10,
    });
    poller.setActiveProfile(PROFILE);
    await wait(50);
    assert.strictEqual(requests, 0, "invisible view generates no traffic");
    poller.setVisible(true);
    await wait(65);
    const whileVisible = requests;
    assert.ok(whileVisible >= 2, `expected polling, saw ${whileVisible}`);
    poller.setVisible(false);
    const atHide = requests;
    await wait(60);
    assert.strictEqual(requests, atHide, "hiding stops polling entirely");
    poller.dispose();
  });

  test("eight configured profiles produce at most one poller stream (active profile only)", async () => {
    const pinged = new Set<string>();
    const poller = new HealthPoller({
      ping: async (p) => {
        pinged.add(p.id);
        return 5;
      },
      intervalMs: () => 10,
    });
    // Eight profiles exist; only one is ever active at a time.
    const profiles = Array.from({ length: 8 }, (_, n) => profileN(n));
    poller.setActiveProfile(profiles[3]);
    poller.setVisible(true);
    await wait(50);
    poller.dispose();
    assert.deepStrictEqual([...pinged], ["p-3"]);
  });

  test("interval 0 disables polling", async () => {
    let requests = 0;
    const poller = new HealthPoller({
      ping: async () => {
        requests += 1;
        return 5;
      },
      intervalMs: () => 0,
    });
    poller.setActiveProfile(PROFILE);
    poller.setVisible(true);
    await wait(40);
    assert.strictEqual(requests, 0);
    poller.dispose();
  });

  test("a persistently unreachable operator backs off instead of retrying at the base interval", async () => {
    const poller = new HealthPoller({
      ping: async () => {
        throw new Error("unreachable");
      },
      intervalMs: () => 100,
    });
    poller.setActiveProfile(PROFILE);
    assert.strictEqual(poller.currentDelayMs(), 100);
    await poller.pollOnce();
    assert.strictEqual(poller.currentDelayMs(), 200);
    await poller.pollOnce();
    assert.strictEqual(poller.currentDelayMs(), 400);
    for (let i = 0; i < 10; i++) {
      await poller.pollOnce();
    }
    // Capped: bounded backoff, not an ever-growing silence.
    assert.strictEqual(poller.currentDelayMs(), 800);
    // And the rendered state is Unmonitored — not an error state.
    assert.strictEqual(poller.livenessFor(PROFILE.id)?.signal, "unmonitored");
    poller.dispose();
  });

  test("a success resets the backoff", async () => {
    let fail = true;
    const poller = new HealthPoller({
      ping: async () => {
        if (fail) {
          throw new Error("unreachable");
        }
        return 7;
      },
      intervalMs: () => 100,
    });
    poller.setActiveProfile(PROFILE);
    await poller.pollOnce();
    await poller.pollOnce();
    assert.strictEqual(poller.currentDelayMs(), 400);
    fail = false;
    await poller.pollOnce();
    assert.strictEqual(poller.currentDelayMs(), 100);
    assert.strictEqual(poller.livenessFor(PROFILE.id)?.signal, "reachable");
    poller.dispose();
  });
});

suite("the fleet infrastructure boundary", () => {
  // Both fleet surfaces are unreachable from a client context BY
  // DESIGN (internal ingress on the control plane; mTLS on the host
  // daemon). Reaching them would mean loosening an ingress rule or
  // shipping ops credentials inside a public .vsix — so the assertion
  // is enforced here, in code, where adding such a call fails the
  // build rather than surviving review.
  const forbidden = [
    "fleet" + "-api",
    "fleet" + "_api",
    "fleetapi",
    "operator" + "-fleet",
    "operator" + "_fleet",
    ":9191",
  ];

  function scan(label: string, content: string): void {
    const lower = content.toLowerCase();
    for (const needle of forbidden) {
      assert.ok(
        !lower.includes(needle),
        `${label} must not reference ${needle} — the extension talks ONLY to the operator's own owner-facing API`,
      );
    }
  }

  test("no shipped code path can reach fleet infrastructure", () => {
    const ext = vscode.extensions.getExtension("airdress.airdress-vscode");
    assert.ok(ext);
    // The shipped bundle is the authority — it is what users run.
    scan(
      "dist/extension.js",
      fs.readFileSync(
        path.join(ext.extensionPath, "dist", "extension.js"),
        "utf8",
      ),
    );
  });

  test("no source module references fleet infrastructure (tests excluded)", () => {
    const root = path.resolve(__dirname, "..", "..", "src");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return entry.name === "test" ? [] : walk(full);
        }
        return entry.name.endsWith(".ts") ? [full] : [];
      });
    const files = walk(root);
    assert.ok(files.length > 10, "source scan found the tree");
    for (const file of files) {
      scan(path.relative(root, file), fs.readFileSync(file, "utf8"));
    }
  });
});
