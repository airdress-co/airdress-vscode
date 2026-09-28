import * as assert from "assert";
import { ApiClient, ApiError } from "../api/client";
import type { Profile } from "../profiles/model";
import {
  homeDescription,
  homeDetailRows,
  isKindAbsent,
  listHomes,
  parseHome,
  parseHomeListing,
} from "../homes/model";

const OWNER: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

/** A `ResourceView` as `GET /v1/kinds/Home` lists it, connected. */
function wireHome(
  over: {
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    apiVersion: "airdress.co/v1alpha1",
    kind: "Home",
    metadata: {
      name: "home",
      generation: 1,
      resourceVersion: "3",
      labels: {},
      created_at: "2026-09-28T08:00:00Z",
      updated_at: "2026-09-28T08:00:00Z",
    },
    spec: {
      hub: {
        homeAssistant: { machine: "7bcf8051-0000-4000-8000-000000000001" },
      },
      ceiling: "mirror",
      sensitive: [{ entity: "cover.garage_door", allow: "operate" }],
      notify: { enabled: true, perMinute: 3, perDay: 200 },
      limits: {
        callsPerMinute: 3,
        observePerMinute: 20,
        readsPerMinute: 10,
        emitsPerMinute: 10,
      },
      enabled: true,
      ...over.spec,
    },
    status: {
      conditions: [
        {
          type: "Linked",
          status: "True",
          reason: "MachineApproved",
          message: "the machine is approved",
          lastTransitionTime: "2026-09-28T08:00:00Z",
        },
        {
          type: "Connected",
          status: "True",
          reason: "ChannelUp",
          lastTransitionTime: "2026-09-28T08:00:00Z",
        },
        {
          type: "Ready",
          status: "True",
          reason: "Ready",
          lastTransitionTime: "2026-09-28T08:00:00Z",
        },
      ],
      hub: {
        kind: "homeAssistant",
        version: "2026.10.0",
        integrationVersion: "0.1.0",
      },
      protocolVersion: "airdress.home.v1",
      transport: "ws",
      shared: [
        { entity: "light.kitchen", level: "operate" },
        { entity: "sensor.washer_status", level: "observe" },
        {
          entity: "cover.garage_door",
          level: "operate",
          deviceClass: "garage",
        },
      ],
      effective: [
        { entity: "light.kitchen", level: "operate" },
        { entity: "sensor.washer_status", level: "observe" },
      ],
      connectedSince: "2026-09-28T08:01:00Z",
      lastSeenAt: "2026-09-28T08:05:00Z",
      displacements24h: 0,
      conversation: "0b9e2d8a-0000-4000-8000-000000000002",
      ...over.status,
    },
  };
}

/** An ApiClient whose fetch answers one fixed response. */
function clientAnswering(status: number, body: unknown): ApiClient {
  return new ApiClient({
    baseUrl: `https://${OWNER.fqdn}`,
    getToken: async () => "t",
    fetchFn: (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
}

suite("Homes", () => {
  test("decodes the hub, the channel and the counts from the wire", () => {
    const h = parseHome(wireHome());
    assert.ok(h);
    assert.strictEqual(h.name, "home");
    assert.strictEqual(h.hubKind, "homeAssistant");
    assert.strictEqual(h.machine, "7bcf8051-0000-4000-8000-000000000001");
    assert.strictEqual(h.hubVersion, "2026.10.0");
    assert.strictEqual(h.integrationVersion, "0.1.0");
    assert.strictEqual(h.transport, "ws");
    assert.deepStrictEqual(h.shared, { operate: 2, observe: 3 });
    assert.deepStrictEqual(h.effective, { operate: 1, observe: 2 });
    assert.deepStrictEqual(h.sensitive, ["cover.garage_door"]);
    assert.strictEqual(h.hasConversation, true);
    assert.deepStrictEqual(
      h.conditions.map((c) => `${c.type}=${c.status}/${c.reason}`),
      [
        "Linked=True/MachineApproved",
        "Connected=True/ChannelUp",
        "Ready=True/Ready",
      ],
    );
  });

  test("a spec that leaves notify and limits out reads the operator's defaults", () => {
    const item = wireHome();
    const spec = item.spec as Record<string, unknown>;
    delete spec.notify;
    delete spec.limits;
    const h = parseHome(item);
    assert.ok(h);
    assert.deepStrictEqual(h.notify, {
      enabled: true,
      perMinute: 3,
      perDay: 200,
    });
    assert.deepStrictEqual(h.limits, {
      callsPerMinute: 3,
      observePerMinute: 20,
      readsPerMinute: 10,
      emitsPerMinute: 10,
    });
  });

  test("a hub that never connected says so, with the reason on each condition", () => {
    const h = parseHome(
      wireHome({
        status: {
          hub: undefined,
          transport: undefined,
          connectedSince: undefined,
          lastSeenAt: undefined,
          shared: [],
          effective: [],
          conditions: [
            {
              type: "Connected",
              status: "False",
              reason: "ChannelDown",
              lastTransitionTime: "2026-09-28T08:00:00Z",
            },
          ],
        },
      }),
    );
    assert.ok(h);
    assert.strictEqual(homeDescription(h), "Home Assistant · never connected");
    const rows = homeDetailRows(h);
    assert.ok(
      rows.some((r) => r.label === "Not connected" && r.value === "never seen"),
    );
    assert.ok(
      rows.some(
        (r) => r.label === "Connected" && r.value === "False · ChannelDown",
      ),
    );
    assert.ok(
      rows.some((r) => r.label === "Hub" && /not reported yet/.test(r.value)),
    );
  });

  test("the rows name the sensitive opt-ins, those not shared, notify and the limits", () => {
    const h = parseHome(
      wireHome({
        spec: { notify: { enabled: false } },
        status: { sensitiveNotShared: ["lock.front_door"] },
      }),
    );
    assert.ok(h);
    const byLabel = new Map(homeDetailRows(h).map((r) => [r.label, r.value]));
    assert.strictEqual(byLabel.get("Sensitive opt-ins"), "cover.garage_door");
    assert.strictEqual(
      byLabel.get("Opted in, not shared by the hub"),
      "lock.front_door",
    );
    assert.strictEqual(byLabel.get("Notify"), "off");
    assert.strictEqual(
      byLabel.get("Limits"),
      "operate 3/min · observe 20/min · reads 10/min · emits 10/min",
    );
    assert.strictEqual(
      byLabel.get("Shared by the hub"),
      "2 operate · 3 observe",
    );
    assert.strictEqual(
      byLabel.get("Usable by functions"),
      "1 operate · 2 observe",
    );
    assert.strictEqual(homeDescription(h), "Home Assistant · connected (ws)");
  });

  test("the listing drops nameless rows, sorts by name, and reads a shape without items as none", () => {
    const b = wireHome();
    (b.metadata as Record<string, unknown>).name = "b-home";
    const a = wireHome();
    (a.metadata as Record<string, unknown>).name = "a-home";
    const homes = parseHomeListing({
      kind: "Home",
      items: [b, { spec: {} }, a],
    });
    assert.deepStrictEqual(
      homes.map((h) => h.name),
      ["a-home", "b-home"],
    );
    assert.deepStrictEqual(parseHomeListing({}), []);
    assert.deepStrictEqual(parseHomeListing(null), []);
  });

  test("an operator without the Kind is an empty view, not an error", async () => {
    // The operator answers an unregistered kind 400 "unknown kind"; the
    // contract says 404. Both mean no homes here.
    assert.deepStrictEqual(
      await listHomes(
        clientAnswering(400, { error: "unknown kind 'Home'", path: "kind" }),
      ),
      [],
    );
    assert.deepStrictEqual(await listHomes(clientAnswering(404, {})), []);
  });

  test("any other failure still reaches the caller", async () => {
    await assert.rejects(
      listHomes(clientAnswering(403, { error: "resource_forbidden" })),
      (err: unknown) => err instanceof ApiError && err.httpStatus === 403,
    );
    assert.strictEqual(
      isKindAbsent(new ApiError({ status: 400, detail: "spec invalid" }, 400)),
      false,
    );
  });
});
