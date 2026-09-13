import * as assert from "assert";
import { SelectorController, type SelectorHost } from "../selector/controller";
import {
  parseSelectorAction,
  type SelectorHostMessage,
} from "../selector/protocol";

/**
 * The selector's every state and every action, through its host seam.
 * Nothing here opens a window; the view's HTML shell has its own test.
 */
class FakeHost implements SelectorHost {
  readonly posted: SelectorHostMessage[] = [];
  readonly calls: string[] = [];
  list: Array<{
    id: string;
    label: string;
    fqdn: string;
    authMode: "zitadel" | "bearer";
  }> = [
    { id: "op1", label: "one", fqdn: "one.a.airdr.es", authMode: "zitadel" },
    { id: "op2", label: "two", fqdn: "two.a.airdr.es", authMode: "bearer" },
  ];
  active: string | undefined = "op1";
  reachable = true;
  cred: "signed-in" | "needs-sign-in" | "unknown" = "signed-in";
  profiles() {
    return this.list;
  }
  activeId() {
    return this.active;
  }
  reach(id: string) {
    this.calls.push(`reach ${id}`);
    return this.reachable
      ? { reach: "reachable" as const, latencyMs: 42 }
      : { reach: "unreachable" as const };
  }
  credential(id: string) {
    this.calls.push(`credential ${id}`);
    return this.cred;
  }
  async activate(id: string) {
    this.calls.push(`activate ${id}`);
    this.active = id;
  }
  async signInAgain(id: string) {
    this.calls.push(`signInAgain ${id}`);
  }
  async connect() {
    this.calls.push("connect");
  }
  async probe(id: string) {
    this.calls.push(`probe ${id}`);
  }
  post(message: SelectorHostMessage) {
    this.posted.push(message);
  }
  last() {
    return this.posted[this.posted.length - 1].state;
  }
}

suite("selector: state", () => {
  test("the active airdress with both facts, and every other profile listed", () => {
    const host = new FakeHost();
    const s = new SelectorController(host).state();
    assert.deepStrictEqual(s.active, {
      id: "op1",
      label: "one",
      fqdn: "one.a.airdr.es",
      authMode: "zitadel",
      reach: "reachable",
      latencyMs: 42,
      credential: "signed-in",
    });
    assert.strictEqual(s.profiles.length, 2);
    assert.strictEqual(s.busy, false);
  });

  test("needs-sign-in and unreachable are facts the state carries as given", () => {
    const host = new FakeHost();
    host.reachable = false;
    host.cred = "needs-sign-in";
    const s = new SelectorController(host).state();
    assert.strictEqual(s.active?.reach, "unreachable");
    assert.strictEqual(s.active?.latencyMs, undefined);
    assert.strictEqual(s.active?.credential, "needs-sign-in");
  });

  test("no active, or an active id whose row is gone, is the empty state — with the profiles still offered", () => {
    const host = new FakeHost();
    host.active = undefined;
    assert.strictEqual(new SelectorController(host).state().active, undefined);
    host.active = "ghost";
    const s = new SelectorController(host).state();
    assert.strictEqual(s.active, undefined);
    assert.strictEqual(s.profiles.length, 2);
  });

  test("the state never carries a token-shaped field", () => {
    const host = new FakeHost();
    const json = JSON.stringify(new SelectorController(host).state());
    assert.ok(
      !/token|secret|bearer[A-Z]|refresh/i.test(
        json.replace(/"authMode":"bearer"/g, ""),
      ),
      json,
    );
  });
});

suite("selector: actions", () => {
  test("load renders; switch activates a known id and re-renders; an unknown id is ignored", async () => {
    const host = new FakeHost();
    const c = new SelectorController(host);
    await c.handle({ type: "load" });
    assert.strictEqual(host.posted.length, 1);
    await c.handle({ type: "switch", id: "op2" });
    assert.strictEqual(host.active, "op2");
    assert.strictEqual(host.last().active?.id, "op2");
    await c.handle({ type: "switch", id: "nope" });
    assert.strictEqual(host.active, "op2");
    assert.ok(!host.calls.includes("activate nope"));
  });

  test("signInAgain targets the ACTIVE profile and renders busy around it", async () => {
    const host = new FakeHost();
    const c = new SelectorController(host);
    await c.handle({ type: "signInAgain" });
    assert.ok(host.calls.includes("signInAgain op1"));
    assert.deepStrictEqual(
      host.posted.map((m) => m.state.busy),
      [true, false],
    );
  });

  test("refresh probes the active profile; with nothing active it only renders", async () => {
    const host = new FakeHost();
    const c = new SelectorController(host);
    await c.handle({ type: "refresh" });
    assert.ok(host.calls.includes("probe op1"));
    host.active = undefined;
    host.calls.length = 0;
    await c.handle({ type: "refresh" });
    assert.ok(!host.calls.some((l) => l.startsWith("probe")));
  });

  test("connect runs the connect flow; malformed messages are dropped", async () => {
    const host = new FakeHost();
    const c = new SelectorController(host);
    await c.handle({ type: "connect" });
    assert.ok(host.calls.includes("connect"));
    await c.handle({ type: "switch" });
    await c.handle("nonsense");
    await c.handle({ type: "delete" });
    assert.strictEqual(
      host.calls.filter((l) => l.startsWith("activate")).length,
      0,
    );
    assert.strictEqual(
      parseSelectorAction({ type: "switch", id: "" }),
      undefined,
    );
  });
});
