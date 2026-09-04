import { ApiError } from "../api/client";
import type { Profile } from "../profiles/model";
import { clientFor, type ManifestDeps } from "../manifests/diff";
import type {
  EnrollmentMeta,
  PrincipalMeta,
  ResourceRef,
  TreeFetchers,
} from "./nodes";

/**
 * Live operator fetchers for the resource tree (SPEC-057 T6-06).
 *
 * `listPrincipals` maps 403 (sub_user_forbidden per SPEC-042) and 404
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
