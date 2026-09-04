import { ApiError } from "../api/client";
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
 * Defensive status parsing: the roll-up needs one boolean and one word.
 * Anything the response does not state explicitly degrades to
 * not-ready with an honest "Unknown" — never to a green checkmark.
 */
export function parseResourceStatus(
  response: Record<string, unknown> | null | undefined,
): ResourceStatus {
  const r = response ?? {};
  const word = [r.state, r.phase, r.status]
    .map((v) => (typeof v === "string" ? v : undefined))
    .find((v) => v !== undefined);
  const ready =
    r.ready === true || (word !== undefined && word.toLowerCase() === "ready");
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
      const response = await clientFor(deps, profile).request<{
        kinds: string[];
      }>("/v1/kinds");
      return response.kinds;
    },

    async listResources(
      profile: Profile,
      kind: string,
    ): Promise<ResourceRef[]> {
      const response = await clientFor(deps, profile).request<{
        items: Array<{ kind: string; name: string }>;
      }>(`/v1/kinds/${encodeURIComponent(kind)}`);
      return response.items.map((r) => ({ kind: r.kind, name: r.name }));
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
      const response = await clientFor(deps, profile).request<{
        items: Array<{ id: string; created_at: string }>;
      }>("/v1/endpoints/enrollments");
      return response.items.map((e) => ({
        id: e.id,
        createdAt: e.created_at,
      }));
    },
  };
}
