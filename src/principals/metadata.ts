import type { ForbiddenContentFields } from "../tree/nodes";

/**
 * A principal's admin metadata, re-checked at THIS surface: the owner
 * is admin-only with no plaintext path to a sub-user's content, and
 * every new surface is a new place that boundary could leak. The
 * mapping below is an ALLOWLIST of scalar fields — a misbehaving (or
 * future, wider) operator response cannot smuggle content into the
 * rendered view, because unknown keys are dropped before rendering and
 * the type cannot hold them.
 */
export interface SubUserAdminMetadata extends ForbiddenContentFields {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly oidcIssuer?: string;
  readonly oidcSub?: string;
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Total mapping from the wire response to the view model. Only the
 * allowlisted scalar fields are copied; everything else — whatever it
 * is called — never leaves this function.
 */
export function toAdminMetadata(
  wire: Record<string, unknown> | null | undefined,
): SubUserAdminMetadata {
  const w = wire ?? {};
  return {
    id: scalar(w.id) ?? "unknown",
    displayName: scalar(w.display_name) ?? scalar(w.name) ?? "unknown",
    createdAt: scalar(w.created_at) ?? "unknown",
    lastUsedAt: scalar(w.last_used_at),
    revokedAt: scalar(w.revoked_at),
    oidcIssuer: scalar(w.oidc_issuer),
    oidcSub: scalar(w.oidc_sub),
  };
}

/** Render the metadata as display lines (read-only, scalars only). */
export function metadataLines(meta: SubUserAdminMetadata): string[] {
  const lines = [
    `# Sub-user admin metadata — metadata only, read-only.`,
    `# The owner has no path to this sub-user's message content.`,
    `id: ${meta.id}`,
    `displayName: ${meta.displayName}`,
    `createdAt: ${meta.createdAt}`,
  ];
  if (meta.lastUsedAt) {
    lines.push(`lastUsedAt: ${meta.lastUsedAt}`);
  }
  if (meta.revokedAt) {
    lines.push(`revokedAt: ${meta.revokedAt}`);
  }
  if (meta.oidcIssuer) {
    lines.push(`oidcIssuer: ${meta.oidcIssuer}`);
  }
  if (meta.oidcSub) {
    lines.push(`oidcSub: ${meta.oidcSub}`);
  }
  return lines;
}
