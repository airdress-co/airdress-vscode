import type { Profile } from "../profiles/model";

/**
 * Operator API client: fetch wrapper + RFC 7807 Problem parsing.
 *
 * SECURITY: the bearer is attached to the request and appears nowhere
 * else — never in an error, never in a log, never in a diagnostic.
 */

/**
 * Error body, as the operator emits it. Two shapes exist on the wire:
 * RFC 7807 problem details (`title`/`detail`), and the operator's
 * manifest-rejection shape — HTTP 400 with `{"error": "<message>",
 * "path": "<json-path>"}`. Both are parsed into this one type; callers
 * check which fields are present.
 */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /** Rejection message from the `{error, path}` shape, verbatim. */
  error?: string;
  /** JSON path of the offending field from the `{error, path}` shape. */
  path?: string;
}

export class ApiError extends Error {
  constructor(
    readonly problem: Problem,
    readonly httpStatus: number,
  ) {
    super(
      problem.title ??
        problem.error ??
        `Operator API error (HTTP ${httpStatus})`,
    );
    this.name = "ApiError";
  }
}

/** Thrown when a profile has no credential — callers prompt once. */
export class NotAuthenticatedError extends Error {
  constructor(profileLabel: string) {
    super(
      `Profile "${profileLabel}" has no credential — sign in or enter a bearer token first.`,
    );
    this.name = "NotAuthenticatedError";
  }
}

/**
 * Base URL for a profile. Operators are reached via their airdress FQDN
 * over HTTPS (the relay TLS path). Dev profiles targeting localhost
 * speak plain HTTP to the operator's default local port.
 */
export function baseUrlFor(profile: Profile): string {
  if (profile.dev && profile.fqdn.toLowerCase() === "localhost") {
    return "http://127.0.0.1:8080";
  }
  return `https://${profile.fqdn}`;
}

/** Parse a Problem body defensively; never throws. */
export function parseProblem(body: unknown, httpStatus: number): Problem {
  if (typeof body === "object" && body !== null) {
    const p = body as Record<string, unknown>;
    return {
      type: typeof p.type === "string" ? p.type : undefined,
      title: typeof p.title === "string" ? p.title : undefined,
      status: typeof p.status === "number" ? p.status : httpStatus,
      detail: typeof p.detail === "string" ? p.detail : undefined,
      instance: typeof p.instance === "string" ? p.instance : undefined,
      error: typeof p.error === "string" ? p.error : undefined,
      path: typeof p.path === "string" ? p.path : undefined,
    };
  }
  return { status: httpStatus };
}

export interface ClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | undefined>;
  /** Request timeout in ms (`airdress.requestTimeoutMs`). */
  timeoutMs?: number;
  /** `airdress.telemetry.traceHeader` — send x-airdress-trace: 1. */
  traceHeader?: boolean;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Names the profile in NotAuthenticatedError messages. */
  profileLabel?: string;
}

export class ApiClient {
  constructor(private readonly opts: ClientOptions) {}

  /**
   * Perform a request. Non-2xx responses throw {@link ApiError} with
   * the operator's RFC 7807 body parsed (title/detail verbatim).
   */
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.send(path, init);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  /** Like request() but returns the raw Response for callers that care. */
  async send(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.opts.getToken();
    if (!token) {
      throw new NotAuthenticatedError(this.opts.profileLabel ?? "unknown");
    }
    const fetchFn = this.opts.fetchFn ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? 15_000,
    );
    let response: Response;
    try {
      response = await fetchFn(new URL(path, this.opts.baseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, application/problem+json",
          ...(this.opts.traceHeader ? { "x-airdress-trace": "1" } : {}),
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      throw new ApiError(parseProblem(body, response.status), response.status);
    }
    return response;
  }
}
