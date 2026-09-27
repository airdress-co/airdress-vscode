import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { ApiClient } from "../api/client";
import type { Profile } from "../profiles/model";
import {
  approvalBody,
  ApprovalError,
  describeMachineError,
  enrollmentPath,
  isExpired,
  linkNameProblem,
  offersHomeLink,
  parsePendingListing,
  type PendingEnrollment,
} from "../machines/pending";
import {
  approvePendingMachine,
  comparisonTitle,
  denyPendingMachine,
  type Comparison,
  type LinkChoice,
  type PendingMachineDeps,
} from "../machines/commands";
import { detailRows } from "../machines/view";

const OWNER: Profile = {
  id: "p-owner",
  label: "ada",
  fqdn: "ada.a.airdr.es",
  authMode: "zitadel",
  dev: false,
};

const FP =
  "SHA256:9d6e4cc0bbd1d7f5d0f4b2b5c6a2a0f1a8e0c0d4a3e5b7c9d1f3a5b7c9d1e3f5";

/** A listing row as the operator sends it, with overrides. */
function wireRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_code: "WDJBMJHT",
    name: "ha-kitchen",
    fingerprint: FP,
    kind: "new",
    machine_id: null,
    preauth_key_id: null,
    confirmation_code: "4821-7730",
    created_at: "2026-09-27T10:00:00Z",
    expires_at: "2999-01-01T00:00:00Z",
    purpose: "home-assistant",
    links: ["Home"],
    ...over,
  };
}

function one(over: Record<string, unknown> = {}): PendingEnrollment {
  const [e] = parsePendingListing({ enrollments: [wireRow(over)] });
  assert.ok(e);
  return e;
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/** A client whose fetch records calls and answers with `respond`. */
function fakeClient(
  calls: Call[],
  respond: (call: Call) => { status: number; body?: unknown },
): ApiClient {
  return new ApiClient({
    baseUrl: `https://${OWNER.fqdn}`,
    getToken: async () => "owner-jwt",
    fetchFn: (async (input: URL | string, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const { status, body } = respond(call);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

interface Harness {
  deps: PendingMachineDeps;
  calls: Call[];
  infos: string[];
  errors: string[];
  asked: { homeLink: number; deny: number };
}

function harness(opts: {
  compare?: Comparison;
  link?: LinkChoice;
  deny?: boolean;
  respond?: (call: Call) => { status: number; body?: unknown };
}): Harness {
  const calls: Call[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const asked = { homeLink: 0, deny: 0 };
  const respond =
    opts.respond ??
    ((call: Call) =>
      call.url.endsWith("/deny")
        ? { status: 204 }
        : {
            status: 200,
            body: {
              machine_id: "7bcf8051-0000-4000-8000-000000000001",
              name: "ha-kitchen",
              ...(isRecord(call.body) && call.body.link
                ? { link: call.body.link }
                : {}),
            },
          });
  return {
    calls,
    infos,
    errors,
    asked,
    deps: {
      client: () => fakeClient(calls, respond),
      refresh: () => undefined,
      ui: {
        compare: async () => opts.compare,
        chooseHomeLink: async () => {
          asked.homeLink++;
          return opts.link;
        },
        confirmDeny: async () => {
          asked.deny++;
          return opts.deny ?? false;
        },
        info: (m) => infos.push(m),
        error: (m) => errors.push(m),
      },
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

suite("Pending machines — listing", () => {
  test("decodes a row, and an absent links field is no links", () => {
    const e = one({ links: undefined, purpose: null });
    assert.deepStrictEqual(e.links, []);
    assert.strictEqual(e.purpose, undefined);
    assert.strictEqual(e.confirmationCode, "4821-7730");
    assert.strictEqual(e.userCode, "WDJBMJHT");
  });

  test("a row that cannot be compared is dropped, not shown", () => {
    assert.deepStrictEqual(
      parsePendingListing({
        enrollments: [wireRow({ fingerprint: undefined }), wireRow()],
      }).length,
      1,
    );
    assert.deepStrictEqual(parsePendingListing({}), []);
    assert.deepStrictEqual(parsePendingListing(null), []);
  });

  test("detail rows carry every fact the owner decides on", () => {
    const labels = detailRows(one()).map((r) => r.label);
    for (const want of [
      "Confirmation code",
      "Fingerprint",
      "User code",
      "Purpose",
      "Can be linked as",
      "Expires",
    ]) {
      assert.ok(labels.includes(want), `missing ${want}`);
    }
    const plain = detailRows(one({ links: [], confirmation_code: null }));
    assert.ok(!plain.some((r) => r.label === "Can be linked as"));
    assert.ok(!plain.some((r) => r.label === "Confirmation code"));
  });

  test("expiry reads the listing's timestamp", () => {
    assert.strictEqual(isExpired(one()), false);
    assert.strictEqual(
      isExpired(one({ expires_at: "2020-01-01T00:00:00Z" })),
      true,
    );
  });
});

suite("Pending machines — request bodies", () => {
  test("the confirmation code is sent when the listing has one", () => {
    assert.deepStrictEqual(approvalBody(one()), {
      confirmation_code: "4821-7730",
    });
  });

  test("the fingerprint is sent when there is no code — never both", () => {
    assert.deepStrictEqual(approvalBody(one({ confirmation_code: null })), {
      fingerprint: FP,
    });
  });

  test("a Home link is added only when advertised", () => {
    assert.deepStrictEqual(
      approvalBody(one(), { kind: "Home", name: "home" }),
      { confirmation_code: "4821-7730", link: { kind: "Home", name: "home" } },
    );
    assert.throws(
      () => approvalBody(one({ links: [] }), { kind: "Home", name: "home" }),
      ApprovalError,
    );
    assert.throws(
      () =>
        approvalBody(one({ links: undefined }), { kind: "Home", name: "home" }),
      ApprovalError,
    );
  });

  test("offersHomeLink follows links, absent meaning none", () => {
    assert.strictEqual(offersHomeLink(one()), true);
    assert.strictEqual(offersHomeLink(one({ links: [] })), false);
    assert.strictEqual(offersHomeLink(one({ links: undefined })), false);
    assert.strictEqual(offersHomeLink(one({ links: ["Other"] })), false);
  });

  test("link names follow the operator's label rule", () => {
    for (const ok of ["home", "h", "home-2", "a".repeat(63)]) {
      assert.strictEqual(linkNameProblem(ok), undefined, ok);
    }
    for (const bad of ["", "Home", "-home", "home-", "a".repeat(64), "ho me"]) {
      assert.ok(linkNameProblem(bad), bad);
    }
    assert.throws(
      () => approvalBody(one(), { kind: "Home", name: "Home" }),
      ApprovalError,
    );
  });

  test("paths escape the user code", () => {
    assert.strictEqual(
      enrollmentPath("WDJB-MJHT", "approve"),
      "/v1/admin/machines/enrollments/WDJB-MJHT/approve",
    );
    assert.strictEqual(
      enrollmentPath("a/b", "deny"),
      "/v1/admin/machines/enrollments/a%2Fb/deny",
    );
  });

  test("the comparison names what is compared", () => {
    assert.match(comparisonTitle(one()), /confirmation code 4821-7730/);
    assert.match(
      comparisonTitle(one({ confirmation_code: null })),
      /fingerprint SHA256:/,
    );
  });
});

suite("Pending machines — approve and deny flows", () => {
  test("approve sends the code after a 'matches' answer", async () => {
    const h = harness({ compare: "matches", link: {} });
    const out = await approvePendingMachine(h.deps, OWNER, one());
    assert.strictEqual(out, "approved");
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0]?.method, "POST");
    assert.ok(h.calls[0]?.url.endsWith("/enrollments/WDJBMJHT/approve"));
    assert.deepStrictEqual(h.calls[0]?.body, {
      confirmation_code: "4821-7730",
    });
    assert.strictEqual(h.asked.homeLink, 1);
  });

  test("approve with Home sends the link and reports it", async () => {
    const h = harness({
      compare: "matches",
      link: { link: { kind: "Home", name: "kitchen" } },
    });
    await approvePendingMachine(h.deps, OWNER, one());
    assert.deepStrictEqual(h.calls[0]?.body, {
      confirmation_code: "4821-7730",
      link: { kind: "Home", name: "kitchen" },
    });
    assert.match(h.infos[0] ?? "", /linked as Home 'kitchen'/);
  });

  test("no Home question when the listing does not offer it", async () => {
    const h = harness({ compare: "matches" });
    await approvePendingMachine(
      h.deps,
      OWNER,
      one({ links: undefined, confirmation_code: null }),
    );
    assert.strictEqual(h.asked.homeLink, 0);
    assert.deepStrictEqual(h.calls[0]?.body, { fingerprint: FP });
  });

  test("no answer to the comparison sends nothing", async () => {
    const h = harness({ compare: undefined });
    assert.strictEqual(
      await approvePendingMachine(h.deps, OWNER, one()),
      "cancelled",
    );
    assert.strictEqual(h.calls.length, 0);
  });

  test("a mismatch never approves; it offers deny", async () => {
    const declined = harness({ compare: "differs", deny: false });
    assert.strictEqual(
      await approvePendingMachine(declined.deps, OWNER, one()),
      "cancelled",
    );
    assert.strictEqual(declined.calls.length, 0);
    assert.strictEqual(declined.asked.deny, 1);

    const denied = harness({ compare: "differs", deny: true });
    assert.strictEqual(
      await approvePendingMachine(denied.deps, OWNER, one()),
      "denied",
    );
    assert.strictEqual(denied.calls.length, 1);
    assert.ok(denied.calls[0]?.url.endsWith("/deny"));
  });

  test("cancelling the Home question sends nothing", async () => {
    const h = harness({ compare: "matches", link: undefined });
    assert.strictEqual(
      await approvePendingMachine(h.deps, OWNER, one()),
      "cancelled",
    );
    assert.strictEqual(h.calls.length, 0);
  });

  test("an expired enrollment is not sent", async () => {
    const h = harness({ compare: "matches" });
    assert.strictEqual(
      await approvePendingMachine(
        h.deps,
        OWNER,
        one({ expires_at: "2020-01-01T00:00:00Z" }),
      ),
      "failed",
    );
    assert.strictEqual(h.calls.length, 0);
  });

  test("deny posts with no body after confirmation", async () => {
    const h = harness({ deny: true });
    assert.strictEqual(
      await denyPendingMachine(h.deps, OWNER, one()),
      "denied",
    );
    assert.strictEqual(h.calls[0]?.method, "POST");
    assert.strictEqual(h.calls[0]?.body, undefined);
    assert.ok(h.calls[0]?.url.endsWith("/enrollments/WDJBMJHT/deny"));
  });

  for (const [code, status, words] of [
    ["confirmation_mismatch", 422, /different key/],
    ["no_pending_enrollment", 404, /no longer waiting/],
    ["enrollment_expired", 410, /expired/],
    ["link_unavailable", 422, /cannot link .* as Home/],
  ] as const) {
    test(`refusal ${code} is said in plain words`, async () => {
      const h = harness({
        compare: "matches",
        link: {},
        respond: () => ({
          status,
          body: { error: { code, message: "operator text" } },
        }),
      });
      assert.strictEqual(
        await approvePendingMachine(h.deps, OWNER, one()),
        "failed",
      );
      assert.match(h.errors[0] ?? "", words);
    });
  }

  test("an unknown refusal falls back to the operator's message", () => {
    assert.strictEqual(describeMachineError(new Error("boom"), "x"), "boom");
  });
});

suite("Pending machines — contributions", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
  ) as {
    contributes: {
      views: { airdress: { id: string; when?: string }[] };
      commands: { command: string }[];
    };
  };

  test("the view is owner-only, like Principals", () => {
    const view = pkg.contributes.views.airdress.find(
      (v) => v.id === "airdress.machines",
    );
    assert.ok(view);
    assert.strictEqual(view.when, "airdress.principalsAvailable");
  });

  test("the three commands are contributed", () => {
    const ids = pkg.contributes.commands.map((c) => c.command);
    for (const id of [
      "airdress.machines.refresh",
      "airdress.machines.approve",
      "airdress.machines.deny",
    ]) {
      assert.ok(ids.includes(id), id);
    }
  });
});
