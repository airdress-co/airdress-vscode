import * as assert from "assert";
import {
  decodeEnrollments,
  decodeKinds,
  decodeResources,
  parseResourceStatus,
  UnrecognizedResponseError,
} from "../tree/fetchers";

/* ------------------------------------------------------------------ *
 * Wire decoding, pinned to bodies captured from a LIVE operator (the
 * shapes that produced `[object Object]` labels and TypeErrors in the
 * tree) plus the shapes the published contract promises. A response
 * neither sends must fail with a human sentence, never a TypeError.
 * ------------------------------------------------------------------ */

/** Captured live body of GET /v1/kinds. */
const LIVE_KINDS = {
  kinds: [
    {
      kind: "InferencePoolMember",
      api_version: "airdress.co/v1alpha1",
      summary_condition_types: ["Healthy"],
    },
  ],
};

/** Captured live body of GET /v1/endpoints/enrollments. */
const LIVE_ENROLLMENTS = {
  enrollments: [
    {
      id: "b7c1c9c2-0000-0000-0000-000000000001",
      device_label: "pixel-9",
      transport_profile: "webpush",
      role: "device",
      key_custody: "device",
      created_at: "2026-09-01T00:00:00Z",
      expires_at: null,
    },
  ],
};

suite("kinds decoding", () => {
  test("live operator body: kind-summary objects become kind names", () => {
    assert.deepStrictEqual(decodeKinds(LIVE_KINDS), ["InferencePoolMember"]);
  });

  test("contract body: plain strings pass through", () => {
    assert.deepStrictEqual(decodeKinds({ kinds: ["A", "B"] }), ["A", "B"]);
  });

  test("empty list is fine", () => {
    assert.deepStrictEqual(decodeKinds({ kinds: [] }), []);
  });

  test("an unrecognized shape throws a human sentence, not a TypeError", () => {
    for (const body of [
      null,
      "oops",
      {},
      { kinds: "not-an-array" },
      { kinds: [42] },
      { kinds: [{ name: "no-kind-field" }] },
    ]) {
      assert.throws(
        () => decodeKinds(body),
        (err: unknown) => {
          assert.ok(err instanceof UnrecognizedResponseError);
          assert.ok(!(err instanceof TypeError));
          assert.doesNotMatch(err.message, /\[object Object\]/);
          assert.match(err.message, /Unrecognized response/);
          return true;
        },
      );
    }
  });
});

suite("enrollments decoding", () => {
  test("live operator body: `enrollments` key with rich rows", () => {
    assert.deepStrictEqual(decodeEnrollments(LIVE_ENROLLMENTS), [
      {
        id: "b7c1c9c2-0000-0000-0000-000000000001",
        createdAt: "2026-09-01T00:00:00Z",
      },
    ]);
  });

  test("contract body: `items` key", () => {
    assert.deepStrictEqual(
      decodeEnrollments({
        items: [{ id: "e1", created_at: "2026-09-01T00:00:00Z" }],
      }),
      [{ id: "e1", createdAt: "2026-09-01T00:00:00Z" }],
    );
  });

  test("an unrecognized shape throws a human sentence, not a TypeError", () => {
    for (const body of [
      null,
      {},
      { enrollments: "x" },
      { enrollments: [{}] },
    ]) {
      assert.throws(
        () => decodeEnrollments(body),
        (err: unknown) =>
          err instanceof UnrecognizedResponseError &&
          !/\[object Object\]/.test(err.message),
      );
    }
  });
});

suite("resources decoding", () => {
  test("live operator body: name nested under metadata", () => {
    assert.deepStrictEqual(
      decodeResources(
        {
          kind: "InferencePoolMember",
          items: [
            {
              apiVersion: "airdress.co/v1alpha1",
              kind: "InferencePoolMember",
              metadata: { name: "member-a", generation: 1 },
              spec: {},
              status: {},
            },
          ],
        },
        "InferencePoolMember",
      ),
      [{ kind: "InferencePoolMember", name: "member-a" }],
    );
  });

  test("contract body: top-level kind + name", () => {
    assert.deepStrictEqual(
      decodeResources({ items: [{ kind: "K", name: "n" }] }, "K"),
      [{ kind: "K", name: "n" }],
    );
  });

  test("an unrecognized shape throws a human sentence, not a TypeError", () => {
    assert.throws(
      () => decodeResources({ resources: [] }, "K"),
      (err: unknown) => err instanceof UnrecognizedResponseError,
    );
  });
});

suite("status parsing", () => {
  test("live operator phase word Healthy counts as ready", () => {
    assert.deepStrictEqual(
      parseResourceStatus({ kind: "K", name: "n", phase: "Healthy" }),
      { ready: true, state: "Healthy" },
    );
  });

  test("Pending and Failed stay not-ready with the verbatim word", () => {
    assert.deepStrictEqual(parseResourceStatus({ phase: "Pending" }), {
      ready: false,
      state: "Pending",
    });
    assert.deepStrictEqual(parseResourceStatus({ phase: "Failed" }), {
      ready: false,
      state: "Failed",
    });
  });

  test("nothing stated degrades to Unknown, never a green checkmark", () => {
    assert.deepStrictEqual(parseResourceStatus({}), {
      ready: false,
      state: "Unknown",
    });
  });
});
