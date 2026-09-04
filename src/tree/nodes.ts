import type { Profile } from "../profiles/model";

/**
 * Tree node data model.
 *
 * The sub-user isolation boundary is stated IN THE TYPES, not in review: the
 * owner has admin-metadata access to sub-users and NO plaintext path to
 * their content. {@link PrincipalMeta} therefore carries metadata
 * fields only — there is no "messages" child node type, no lazy loader
 * that could acquire one, and no field capable of holding message
 * content. The `_contentBoundary` phantom marker makes adding such a
 * field a compile error rather than a review comment, and a type-level
 * test enforces the key set.
 */

/**
 * Field names that could carry isolation-protected content. Declaring
 * them as `never` means any attempt to add such a field to
 * {@link PrincipalMeta} fails to compile.
 */
type ForbiddenContentFields = {
  readonly content?: never;
  readonly message?: never;
  readonly messages?: never;
  readonly blocks?: never;
  readonly body?: never;
  readonly text?: never;
  readonly plaintext?: never;
  readonly ciphertext?: never;
  readonly conversation?: never;
  readonly conversations?: never;
};

/**
 * Admin metadata for a principal — the operator's SubUserSummary shape,
 * and NOTHING more. Metadata only, read-only, owner-visible only.
 */
export interface PrincipalMeta extends ForbiddenContentFields {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

/** An enrollment row (id + timestamp — nothing sensitive). */
export interface EnrollmentMeta {
  readonly id: string;
  readonly createdAt: string;
}

/** A resource row within a kind. */
export interface ResourceRef {
  readonly kind: string;
  readonly name: string;
}

/** Discriminated tree node union. */
export type TreeNodeData =
  | { type: "profile"; profile: Profile }
  | {
      type: "section";
      profile: Profile;
      section: "kinds" | "principals" | "enrollments";
    }
  | { type: "kind"; profile: Profile; kind: string; known: boolean }
  | { type: "resource"; profile: Profile; resource: ResourceRef }
  | { type: "principal"; profile: Profile; principal: PrincipalMeta }
  | { type: "enrollment"; profile: Profile; enrollment: EnrollmentMeta }
  | { type: "message"; text: string };

/**
 * Data the tree needs from the operator, injectable for tests.
 *
 * `listPrincipals` returns "forbidden" for a non-owner principal — the
 * tree then omits the Principals branch entirely (absent, not
 * present-and-403; a visible node that always errors teaches users to
 * ignore errors).
 */
export interface TreeFetchers {
  listKinds(profile: Profile): Promise<string[]>;
  listResources(profile: Profile, kind: string): Promise<ResourceRef[]>;
  listPrincipals(profile: Profile): Promise<PrincipalMeta[] | "forbidden">;
  listEnrollments(profile: Profile): Promise<EnrollmentMeta[]>;
}
