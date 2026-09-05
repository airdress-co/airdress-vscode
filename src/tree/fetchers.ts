import { ApiError } from "../api/client";
import type { components } from "../api/generated/operator";
import type { Profile } from "../profiles/model";
import { clientFor, type ManifestDeps } from "../manifests/diff";
import type {
  EnrollmentMeta,
  PrincipalMeta,
  ResourceRef,
  ResourceStatus,
  TreeFetchers,
} from "./nodes";

/**
 * Wire decoding for the resource tree.
 *
 * Types come from the operator's OpenAPI contract
 * (src/api/generated/operator.ts — generated, committed). Live
 * operators have been observed AHEAD of the published contract, so
 * every decoder also accepts the richer shapes a newer operator sends:
 *
 * - `GET /v1/kinds` — contract: `kinds: string[]`; live operators send
 *   `kinds: [{ kind, api_version, summary_condition_types }]`.
 * - `GET /v1/endpoints/enrollments` — contract: `items: Enrollment[]`;
 *   live operators send `enrollments: [{ id, device_label, … }]`.
 * - `GET /v1/kinds/{kind}` — contract: `items: [{ kind, name }]`; live
 *   operators nest the name under `metadata.name`.
 *
 * A shape neither the contract nor a known-live operator sends throws
 * {@link UnrecognizedResponseError} — a human sentence the tree renders
 * as a message node. Never a TypeError, never `[object Object]`.
 */

type KindList = components["schemas"]["KindList"];
type ResourceList = components["schemas"]["ResourceList"];
type EnrollmentList = components["schemas"]["EnrollmentList"];

/** Shape observed from live operators, newer than the contract. */
interface LiveKindSummary {
  kind: string;
  api_version?: string;
  summary_condition_types?: string[];
}

/** The tree could not make sense of an operator response. */
export class UnrecognizedResponseError extends Error {
  constructor(path: string) {
    super(
      `Unrecognized response from GET ${path} — the operator may be newer than this extension. Try updating the Airdress extension.`,
    );
    this.name = "UnrecognizedResponseError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode `GET /v1/kinds`: contract strings OR live kind-summary objects. */
export function decodeKinds(body: unknown): string[] {
  const kinds = isRecord(body) ? (body as Partial<KindList>).kinds : undefined;
  if (!Array.isArray(kinds)) {
    throw new UnrecognizedResponseError("/v1/kinds");
  }
  const names = kinds
    .map((entry: string | LiveKindSummary | unknown) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (isRecord(entry) && typeof entry.kind === "string") {
        return entry.kind;
      }
      return undefined;
    })
    .filter((k): k is string => k !== undefined);
  if (names.length === 0 && kinds.length > 0) {
    throw new UnrecognizedResponseError("/v1/kinds");
  }
  return names;
}

/** Decode `GET /v1/kinds/{kind}`: name top-level (contract) or under metadata (live). */
export function decodeResources(body: unknown, kind: string): ResourceRef[] {
  const items = isRecord(body)
    ? (body as Partial<ResourceList>).items
    : undefined;
  if (!Array.isArray(items)) {
    throw new UnrecognizedResponseError(`/v1/kinds/${kind}`);
  }
  const refs = items
    .map((entry: unknown): ResourceRef | undefined => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
      const name =
        typeof entry.name === "string"
          ? entry.name
          : typeof metadata?.name === "string"
            ? metadata.name
            : undefined;
      if (name === undefined) {
        return undefined;
      }
      return {
        kind: typeof entry.kind === "string" ? entry.kind : kind,
        name,
      };
    })
    .filter((r): r is ResourceRef => r !== undefined);
  if (refs.length === 0 && items.length > 0) {
    throw new UnrecognizedResponseError(`/v1/kinds/${kind}`);
  }
  return refs;
}

/** Decode `GET /v1/endpoints/enrollments`: `items` (contract) or `enrollments` (live). */
export function decodeEnrollments(body: unknown): EnrollmentMeta[] {
  const record = isRecord(body) ? body : undefined;
  const contractItems = (record as Partial<EnrollmentList> | undefined)?.items;
  const rows = Array.isArray(contractItems)
    ? (contractItems as unknown[])
    : Array.isArray(record?.enrollments)
      ? record.enrollments
      : undefined;
  if (rows === undefined) {
    throw new UnrecognizedResponseError("/v1/endpoints/enrollments");
  }
  const enrollments = rows
    .map((entry: unknown): EnrollmentMeta | undefined => {
      if (!isRecord(entry) || typeof entry.id !== "string") {
        return undefined;
      }
      return {
        id: entry.id,
        createdAt: typeof entry.created_at === "string" ? entry.created_at : "",
      };
    })
    .filter((e): e is EnrollmentMeta => e !== undefined);
  if (enrollments.length === 0 && rows.length > 0) {
    throw new UnrecognizedResponseError("/v1/endpoints/enrollments");
  }
  return enrollments;
}

/**
 * Defensive status parsing: the roll-up needs one boolean and one word.
 * Anything the response does not state explicitly degrades to
 * not-ready with an honest "Unknown" — never to a green checkmark.
 * Live operators report `phase: "Healthy"` for a ready resource.
 */
export function parseResourceStatus(
  response: Record<string, unknown> | null | undefined,
): ResourceStatus {
  const r = response ?? {};
  const word = [r.state, r.phase, r.status]
    .map((v) => (typeof v === "string" ? v : undefined))
    .find((v) => v !== undefined);
  const ready =
    r.ready === true ||
    (word !== undefined && ["ready", "healthy"].includes(word.toLowerCase()));
  return { ready, state: word ?? (ready ? "Ready" : "Unknown") };
}

/** Liveness probe: latency of GET /v1/ping, throwing when unanswered. */
export function pingFetcher(
  deps: ManifestDeps,
): (profile: Profile) => Promise<number> {
  return async (profile: Profile): Promise<number> => {
    const started = Date.now();
    await clientFor(deps, profile).send("/v1/ping");
    return Date.now() - started;
  };
}

/**
 * Live operator fetchers for the resource tree.
 *
 * `listPrincipals` maps 403 (sub_user_forbidden) and 404
 * to "forbidden" so the tree omits the branch entirely. The mapping is
 * total: only metadata fields are copied off the wire, so even a
 * misbehaving operator response cannot smuggle content into the
 * PrincipalMeta type.
 */
export function liveFetchers(deps: ManifestDeps): TreeFetchers {
  return {
    async listKinds(profile: Profile): Promise<string[]> {
      const response = await clientFor(deps, profile).request<unknown>(
        "/v1/kinds",
      );
      return decodeKinds(response);
    },

    async listResources(
      profile: Profile,
      kind: string,
    ): Promise<ResourceRef[]> {
      const response = await clientFor(deps, profile).request<unknown>(
        `/v1/kinds/${encodeURIComponent(kind)}`,
      );
      return decodeResources(response, kind);
    },

    async listPrincipals(
      profile: Profile,
    ): Promise<PrincipalMeta[] | "forbidden"> {
      try {
        const response = await clientFor(deps, profile).request<
          Array<{
            id: string;
            display_name: string;
            created_at: string;
            last_used_at?: string | null;
            revoked_at?: string | null;
          }>
        >("/v1/admin/sub-users");
        return response.map((p) => ({
          id: p.id,
          displayName: p.display_name,
          createdAt: p.created_at,
          lastUsedAt: p.last_used_at ?? undefined,
          revokedAt: p.revoked_at ?? undefined,
        }));
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.httpStatus === 403 || err.httpStatus === 404)
        ) {
          // Non-owner (or older operator): the branch is absent, not
          // present-and-403 (design §6).
          return "forbidden";
        }
        throw err;
      }
    },

    async getStatus(
      profile: Profile,
      kind: string,
      name: string,
    ): Promise<ResourceStatus> {
      const response = await clientFor(deps, profile).request<
        Record<string, unknown>
      >(
        `/v1/kinds/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/status`,
      );
      return parseResourceStatus(response);
    },

    async listEnrollments(profile: Profile): Promise<EnrollmentMeta[]> {
      const response = await clientFor(deps, profile).request<unknown>(
        "/v1/endpoints/enrollments",
      );
      return decodeEnrollments(response);
    },
  };
}
