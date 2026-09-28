import { ApiError, type ApiClient } from "../api/client";

/**
 * Linked homes: the `Home` Kind as the owner reads it.
 *
 * A `Home` is a home hub (today only Home Assistant) linked to this
 * airdress as an approved machine. This view is read-only: what the hub
 * reported, whether its channel is up, what it shares and what functions
 * may therefore use, the sensitive opt-ins, notify and the limits. It
 * never approves, links or exposes anything — approval stays in the
 * Pending Machines view, and editing a `Home` is editing its manifest.
 *
 * Wire shape: `GET /v1/kinds/Home` → `{kind, items: [ResourceView]}`,
 * each with `metadata.name`, `spec` (the operator's `HomeSpec`, camelCase)
 * and `status` (the framework's `conditions[]` beside `HomeStatus`).
 * Everything in this file is free of `vscode` so the tests hold the wire
 * shapes directly.
 */

export const HOME_KIND = "Home";

export type Level = "none" | "observe" | "operate";

export interface HomeCondition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
}

export interface HomeLimits {
  readonly callsPerMinute: number;
  readonly observePerMinute: number;
  readonly readsPerMinute: number;
  readonly emitsPerMinute: number;
}

export interface HomeNotify {
  readonly enabled: boolean;
  readonly perMinute: number;
  readonly perDay: number;
}

/** One linked `Home`, decoded. */
export interface HomeSummary {
  readonly name: string;
  /** The spec's hub variant, e.g. `homeAssistant`. */
  readonly hubKind: string;
  /** The machine the hub connects as. */
  readonly machine?: string;
  /** What the hub reported about itself, once connected. */
  readonly hubVersion?: string;
  readonly integrationVersion?: string;
  readonly protocolVersion?: string;
  /** `ws` or `poll`, while the channel is up. */
  readonly transport?: string;
  readonly connectedSince?: string;
  readonly lastSeenAt?: string;
  readonly displacements24h: number;
  readonly conditions: readonly HomeCondition[];
  readonly shared: { readonly operate: number; readonly observe: number };
  readonly effective: { readonly operate: number; readonly observe: number };
  /** `spec.sensitive`: entity ids opted in for operate. */
  readonly sensitive: readonly string[];
  /** `status.sensitiveNotShared`: opt-ins the hub has not shared (yet). */
  readonly sensitiveNotShared: readonly string[];
  readonly notify: HomeNotify;
  readonly limits: HomeLimits;
  readonly enabled: boolean;
  /** Whether the owner's Home conversation exists. */
  readonly hasConversation: boolean;
}

/** The operator's defaults for a field the spec leaves out (D-45). */
export const DEFAULT_LIMITS: HomeLimits = {
  callsPerMinute: 3,
  observePerMinute: 20,
  readsPerMinute: 10,
  emitsPerMinute: 10,
};

export const DEFAULT_NOTIFY: HomeNotify = {
  enabled: true,
  perMinute: 3,
  perDay: 200,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function levelCounts(v: unknown): { operate: number; observe: number } {
  const rows = Array.isArray(v) ? v.filter(isRecord) : [];
  const level = (r: Record<string, unknown>) => r.level;
  return {
    operate: rows.filter((r) => level(r) === "operate").length,
    // Operate implies observe, as the operator's own columns count it.
    observe: rows.filter(
      (r) => level(r) === "operate" || level(r) === "observe",
    ).length,
  };
}

/** Decode one `ResourceView`; `undefined` when it has no name. */
export function parseHome(item: unknown): HomeSummary | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const name = str(metadata.name) ?? str(item.name);
  if (!name) {
    return undefined;
  }
  const spec = isRecord(item.spec) ? item.spec : {};
  const status = isRecord(item.status) ? item.status : {};
  const hub = isRecord(spec.hub) ? spec.hub : {};
  const hubKind = Object.keys(hub)[0] ?? "unknown";
  const variant = isRecord(hub[hubKind]) ? hub[hubKind] : {};
  const hubStatus = isRecord(status.hub) ? status.hub : {};
  const notify = isRecord(spec.notify) ? spec.notify : {};
  const limits = isRecord(spec.limits) ? spec.limits : {};
  const conditions = (
    Array.isArray(status.conditions) ? status.conditions : []
  ).flatMap((c): HomeCondition[] => {
    if (!isRecord(c) || !str(c.type)) {
      return [];
    }
    return [
      {
        type: c.type as string,
        status: str(c.status) ?? "Unknown",
        reason: str(c.reason),
        message: str(c.message),
      },
    ];
  });
  return {
    name,
    hubKind,
    machine: str(variant.machine),
    hubVersion: str(hubStatus.version),
    integrationVersion: str(hubStatus.integrationVersion),
    protocolVersion: str(status.protocolVersion),
    transport: str(status.transport),
    connectedSince: str(status.connectedSince),
    lastSeenAt: str(status.lastSeenAt),
    displacements24h: num(status.displacements24h, 0),
    conditions,
    shared: levelCounts(status.shared),
    effective: levelCounts(status.effective),
    sensitive: (Array.isArray(spec.sensitive) ? spec.sensitive : [])
      .filter(isRecord)
      .map((s) => str(s.entity))
      .filter((e): e is string => e !== undefined),
    sensitiveNotShared: (Array.isArray(status.sensitiveNotShared)
      ? status.sensitiveNotShared
      : []
    ).filter((e): e is string => typeof e === "string"),
    notify: {
      enabled:
        typeof notify.enabled === "boolean"
          ? notify.enabled
          : DEFAULT_NOTIFY.enabled,
      perMinute: num(notify.perMinute, DEFAULT_NOTIFY.perMinute),
      perDay: num(notify.perDay, DEFAULT_NOTIFY.perDay),
    },
    limits: {
      callsPerMinute: num(limits.callsPerMinute, DEFAULT_LIMITS.callsPerMinute),
      observePerMinute: num(
        limits.observePerMinute,
        DEFAULT_LIMITS.observePerMinute,
      ),
      readsPerMinute: num(limits.readsPerMinute, DEFAULT_LIMITS.readsPerMinute),
      emitsPerMinute: num(limits.emitsPerMinute, DEFAULT_LIMITS.emitsPerMinute),
    },
    enabled: typeof spec.enabled === "boolean" ? spec.enabled : true,
    hasConversation: str(status.conversation) !== undefined,
  };
}

/** Decode `GET /v1/kinds/Home`. A shape without `items` is no homes. */
export function parseHomeListing(body: unknown): HomeSummary[] {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return [];
  }
  return body.items
    .map(parseHome)
    .filter((h): h is HomeSummary => h !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether an error means "this operator has no `Home` Kind". The operator
 * answers an unregistered kind with `400 unknown kind '…'` (the contract
 * says 404); both mean the view is simply empty, never an error.
 */
export function isKindAbsent(err: unknown): boolean {
  if (!(err instanceof ApiError)) {
    return false;
  }
  if (err.httpStatus === 404) {
    return true;
  }
  return err.httpStatus === 400 && /unknown kind/i.test(err.message);
}

/** `GET /v1/kinds/Home`; `[]` when the Kind is absent. */
export async function listHomes(client: ApiClient): Promise<HomeSummary[]> {
  try {
    return parseHomeListing(
      await client.request<unknown>(`/v1/kinds/${HOME_KIND}`),
    );
  } catch (err) {
    if (isKindAbsent(err)) {
      return [];
    }
    throw err;
  }
}

/** A sentence for a listing that failed for another reason. */
export function describeHomesError(err: unknown): string {
  if (err instanceof ApiError && err.httpStatus === 403) {
    return "Homes are shown only to the owner, or to a principal granted read on them.";
  }
  return err instanceof Error ? err.message : String(err);
}

/** The hub variant as a person reads it. */
export function hubLabel(kind: string): string {
  return kind === "homeAssistant" ? "Home Assistant" : kind;
}

/** Whether the channel is up. */
export function isConnected(h: HomeSummary): boolean {
  return h.connectedSince !== undefined;
}

/** The one-line state beside the row's name. */
export function homeDescription(h: HomeSummary): string {
  const parts = [hubLabel(h.hubKind)];
  if (!h.enabled) {
    parts.push("disabled");
  } else if (isConnected(h)) {
    parts.push(h.transport ? `connected (${h.transport})` : "connected");
  } else if (h.lastSeenAt) {
    parts.push(`last seen ${h.lastSeenAt}`);
  } else {
    parts.push("never connected");
  }
  return parts.join(" · ");
}

export interface HomeDetailRow {
  readonly label: string;
  readonly value: string;
  readonly icon: string;
}

function conditionIcon(status: string): string {
  if (status === "True") {
    return "pass";
  }
  return status === "False" ? "error" : "question";
}

/** The rows under one `Home`, in the order they are read. */
export function homeDetailRows(h: HomeSummary): HomeDetailRow[] {
  const version = [
    h.hubVersion ? `${hubLabel(h.hubKind)} ${h.hubVersion}` : undefined,
    h.integrationVersion ? `integration ${h.integrationVersion}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const rows: (HomeDetailRow | undefined)[] = [
    {
      label: "Hub",
      value: version || `${hubLabel(h.hubKind)} (not reported yet)`,
      icon: "home",
    },
    h.machine
      ? { label: "Machine", value: h.machine, icon: "server" }
      : undefined,
    isConnected(h)
      ? {
          label: "Connected",
          value: [h.transport, `since ${h.connectedSince}`]
            .filter(Boolean)
            .join(" · "),
          icon: "plug",
        }
      : {
          label: "Not connected",
          value: h.lastSeenAt ? `last seen ${h.lastSeenAt}` : "never seen",
          icon: "debug-disconnect",
        },
    h.protocolVersion
      ? {
          label: "Protocol",
          value: h.protocolVersion,
          icon: "symbol-namespace",
        }
      : undefined,
    ...h.conditions.map((c) => ({
      label: c.type,
      value: [c.status, c.reason].filter(Boolean).join(" · "),
      icon: conditionIcon(c.status),
    })),
    {
      label: "Shared by the hub",
      value: `${h.shared.operate} operate · ${h.shared.observe} observe`,
      icon: "export",
    },
    {
      label: "Usable by functions",
      value: `${h.effective.operate} operate · ${h.effective.observe} observe`,
      icon: "symbol-function",
    },
    {
      label: "Sensitive opt-ins",
      value: h.sensitive.length === 0 ? "none" : h.sensitive.join(", "),
      icon: h.sensitive.length === 0 ? "lock" : "unlock",
    },
    h.sensitiveNotShared.length > 0
      ? {
          label: "Opted in, not shared by the hub",
          value: h.sensitiveNotShared.join(", "),
          icon: "warning",
        }
      : undefined,
    {
      label: "Notify",
      value: h.notify.enabled
        ? `on · ${h.notify.perMinute}/min · ${h.notify.perDay}/day`
        : "off",
      icon: h.notify.enabled ? "bell" : "bell-slash",
    },
    {
      label: "Limits",
      value: `operate ${h.limits.callsPerMinute}/min · observe ${h.limits.observePerMinute}/min · reads ${h.limits.readsPerMinute}/min · emits ${h.limits.emitsPerMinute}/min`,
      icon: "dashboard",
    },
    h.displacements24h > 0
      ? {
          label: "Displaced channels (24 h)",
          value: String(h.displacements24h),
          icon: "warning",
        }
      : undefined,
  ];
  return rows.filter((r): r is HomeDetailRow => r !== undefined);
}
