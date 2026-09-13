import * as assert from "assert";
import { ApiClient, ApiError, NotAuthenticatedError } from "../api/client";

function fakeFetch(status: number, body: unknown = {}): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as typeof fetch;
}

suite("ApiClient: a 401 is reported, not just thrown", () => {
  test("a 401 calls onUnauthorized once and still throws the operator's problem", async () => {
    let reported = 0;
    const client = new ApiClient({
      baseUrl: "https://op.test",
      getToken: async () => "bearer-1",
      fetchFn: fakeFetch(401, {
        title: "Unauthorized",
        detail: "token expired",
      }),
      onUnauthorized: () => {
        reported += 1;
      },
    });
    await assert.rejects(
      client.request("/v1/kinds"),
      (err: unknown) => err instanceof ApiError && err.httpStatus === 401,
    );
    assert.strictEqual(reported, 1);
  });

  test("other failures and successes do not report", async () => {
    let reported = 0;
    const opts = {
      baseUrl: "https://op.test",
      getToken: async () => "bearer-1",
      onUnauthorized: () => {
        reported += 1;
      },
    };
    await assert.rejects(
      new ApiClient({ ...opts, fetchFn: fakeFetch(403) }).request("/x"),
    );
    await new ApiClient({
      ...opts,
      fetchFn: fakeFetch(200, { ok: 1 }),
    }).request("/x");
    assert.strictEqual(reported, 0);
  });

  test("no credential never reaches the network", async () => {
    let fetched = 0;
    const client = new ApiClient({
      baseUrl: "https://op.test",
      getToken: async () => undefined,
      fetchFn: (async () => {
        fetched += 1;
        return {} as Response;
      }) as typeof fetch,
      profileLabel: "ada",
    });
    await assert.rejects(client.request("/x"), NotAuthenticatedError);
    assert.strictEqual(fetched, 0);
  });
});
