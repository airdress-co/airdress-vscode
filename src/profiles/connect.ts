import * as crypto from "node:crypto";
import type { Profile } from "./model";
import type { ProfileStore } from "./store";
import { validateFqdn } from "./validate";

/**
 * Connect-an-Airdress: hub-backed discovery of the account's claimed
 * names.
 *
 * One command: sign in with the existing ZITADEL PKCE flow, ask the hub
 * (`GET {hub}/api/airdresses`) which Airdresses the account has
 * claimed, quick-pick one, and create the profile from it — binding the
 * just-acquired credential to that profile.
 *
 * Whether the hub accepts the editor's ZITADEL access token on that
 * endpoint is not verified against the live hub yet. The flow is
 * implemented optimistically and degrades EXPLICITLY: a 401/403 or an
 * unreachable hub produces a message naming the reason and offers the
 * existing manual-hostname path. It never falls back silently, never
 * retries in a loop, and never creates a profile the user did not pick.
 */

/** Follow pagination cursors only until this many names are collected. */
export const DISCOVERY_CAP = 200;

/** Hard bound on page fetches, independent of the name cap. */
const MAX_PAGES = 50;

/** One claimed Airdress, as the picker presents it. */
export interface HubAirdress {
  name: string;
  fqdn: string;
  dnsStatus?: string;
}

/** One parsed page of the hub's list response. */
export interface HubPage {
  entries: HubAirdress[];
  nextCursor?: string;
}

export type DiscoveryFailureReason =
  "unauthorized" | "unreachable" | "malformed";

/** Why hub discovery failed — carried to the degradation message. */
export class HubDiscoveryError extends Error {
  constructor(
    readonly reason: DiscoveryFailureReason,
    readonly httpStatus?: number,
  ) {
    super(`Hub discovery failed: ${reason}`);
    this.name = "HubDiscoveryError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Parse one entry defensively. The hub's exact field names are not
 * pinned by a shared contract yet, so:
 *
 * - the display name comes from `name`;
 * - the FQDN is taken from the response's own field when present
 *   (`fqdn`/`hostname`/`domain`) and only otherwise constructed as
 *   `<id>.a.airdr.es` from the entry's `id`;
 * - anything that yields no valid hostname is skipped, not guessed at.
 */
export function parseHubEntry(value: unknown): HubAirdress | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const name = stringField(record, "name");
  if (!name) {
    return undefined;
  }
  let fqdn = stringField(record, "fqdn", "hostname", "domain");
  if (!fqdn) {
    const id = stringField(record, "id");
    if (!id) {
      return undefined;
    }
    fqdn = `${id}.a.airdr.es`;
  }
  if (validateFqdn(fqdn, { allowLocalhost: false }) !== undefined) {
    return undefined;
  }
  return {
    name,
    fqdn,
    dnsStatus: stringField(record, "dns_status", "dnsStatus"),
  };
}

/**
 * Parse one page of the list response. Accepts a bare array or an
 * object wrapping the array under a conventional key; anything else is
 * a malformed response — an error, never an empty success.
 */
export function parseHubPage(body: unknown): HubPage {
  let items: unknown[] | undefined;
  let nextCursor: string | undefined;
  if (Array.isArray(body)) {
    items = body;
  } else {
    const record = asRecord(body);
    if (record) {
      for (const key of ["airdresses", "items", "data", "results"]) {
        if (Array.isArray(record[key])) {
          items = record[key] as unknown[];
          break;
        }
      }
      nextCursor = stringField(record, "next_cursor", "nextCursor");
    }
  }
  if (!items) {
    throw new HubDiscoveryError("malformed");
  }
  return {
    entries: items
      .map(parseHubEntry)
      .filter((e): e is HubAirdress => e !== undefined),
    nextCursor,
  };
}

/**
 * Fetch every page up to {@link DISCOVERY_CAP} names. Deduplicates by
 * FQDN and stops on a repeated or absent cursor — a misbehaving hub
 * can cost at most {@link MAX_PAGES} requests, never a retry loop.
 */
export async function collectAirdresses(
  fetchPage: (cursor?: string) => Promise<HubPage>,
): Promise<HubAirdress[]> {
  const seen = new Map<string, HubAirdress>();
  const usedCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    for (const entry of result.entries) {
      if (!seen.has(entry.fqdn)) {
        seen.set(entry.fqdn, entry);
      }
      if (seen.size >= DISCOVERY_CAP) {
        return [...seen.values()];
      }
    }
    if (!result.nextCursor || usedCursors.has(result.nextCursor)) {
      break;
    }
    usedCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return [...seen.values()];
}

/** Build the page-fetching closure for a hub URL + access token. */
export function hubPageFetcher(
  hubUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): (cursor?: string) => Promise<HubPage> {
  return async (cursor) => {
    const url = new URL("/api/airdresses", hubUrl);
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
    } catch {
      throw new HubDiscoveryError("unreachable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new HubDiscoveryError("unauthorized", response.status);
    }
    if (!response.ok) {
      throw new HubDiscoveryError("unreachable", response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HubDiscoveryError("malformed");
    }
    return parseHubPage(body);
  };
}

/**
 * The explicit degradation message (pure, tested). Always names the
 * hub and WHY discovery is unavailable; the caller pairs it with the
 * manual-hostname offer.
 */
export function discoveryUnavailableMessage(
  hubUrl: string,
  error: HubDiscoveryError,
): string {
  switch (error.reason) {
    case "unauthorized":
      return (
        `Airdress: hub discovery is unavailable — ${hubUrl} rejected the ` +
        `account's token (HTTP ${error.httpStatus ?? 401}). Your sign-in ` +
        `succeeded; the hub may not accept editor sign-ins yet. You can ` +
        `still add the operator by hostname.`
      );
    case "unreachable":
      return (
        `Airdress: hub discovery is unavailable — ${hubUrl} could not be ` +
        `reached` +
        (error.httpStatus ? ` (HTTP ${error.httpStatus})` : "") +
        `. You can still add the operator by hostname.`
      );
    case "malformed":
      return (
        `Airdress: hub discovery is unavailable — ${hubUrl} returned a ` +
        `response this extension does not understand. You can still add ` +
        `the operator by hostname.`
      );
  }
}

/** Everything the flow touches, injectable so the flow is testable. */
export interface ConnectDeps {
  profiles: ProfileStore;
  /** Interactive ZITADEL sign-in, storing the credential under this id. */
  signIn: (profileId: string) => Promise<void>;
  /** The in-memory access token acquired by that sign-in. */
  getToken: (profileId: string) => Promise<string | undefined>;
  /** Drop every credential stored under an abandoned candidate id. */
  discard: (profileId: string) => Promise<void>;
  hubUrl: () => string;
  fetchFn?: typeof fetch;
  ui: ConnectUI;
}

export interface ConnectUI {
  /** Quick-pick over the claimed names; undefined on cancel. */
  pick(entries: HubAirdress[]): Promise<HubAirdress | undefined>;
  /** Show `message` with a manual-hostname action; true if chosen. */
  offerManualEntry(message: string): Promise<boolean>;
  /** Run the existing add-profile-by-hostname command. */
  addProfileManually(): Promise<void>;
  info(message: string): void;
  error(message: string): void;
  focusOperatorsView(): Promise<void>;
}

/**
 * The Connect-an-Airdress command flow. Every exit path that does not
 * end in a created profile discards the candidate credential — an
 * abandoned flow leaves nothing behind, and no ambient default profile
 * is ever created.
 */
export async function connectAirdress(deps: ConnectDeps): Promise<void> {
  const candidateId = crypto.randomUUID();
  try {
    await deps.signIn(candidateId);
  } catch (err) {
    await deps.discard(candidateId);
    deps.ui.error(
      `Airdress: sign-in failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  const token = await deps.getToken(candidateId);
  if (!token) {
    await deps.discard(candidateId);
    deps.ui.error("Airdress: sign-in produced no usable token.");
    return;
  }

  const hubUrl = deps.hubUrl();
  let entries: HubAirdress[];
  try {
    entries = await collectAirdresses(
      hubPageFetcher(hubUrl, token, deps.fetchFn),
    );
  } catch (err) {
    await deps.discard(candidateId);
    const failure =
      err instanceof HubDiscoveryError
        ? err
        : new HubDiscoveryError("unreachable");
    const manual = await deps.ui.offerManualEntry(
      discoveryUnavailableMessage(hubUrl, failure),
    );
    if (manual) {
      await deps.ui.addProfileManually();
    }
    return;
  }

  if (entries.length === 0) {
    await deps.discard(candidateId);
    const manual = await deps.ui.offerManualEntry(
      "Airdress: this account has no claimed Airdresses yet. You can " +
        "claim one on the hub, or add an operator by hostname.",
    );
    if (manual) {
      await deps.ui.addProfileManually();
    }
    return;
  }

  const picked = await deps.ui.pick(entries);
  if (!picked) {
    await deps.discard(candidateId);
    return;
  }

  const profile: Profile = {
    id: candidateId,
    label: picked.name,
    fqdn: picked.fqdn,
    authMode: "zitadel",
    dev: false,
  };
  try {
    await deps.profiles.add(profile, { allowLocalhost: false });
  } catch (err) {
    await deps.discard(candidateId);
    deps.ui.error(
      `Airdress: could not create the profile — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  await deps.profiles.setActive(profile.id);
  deps.ui.info(`Airdress: connected ${picked.name} (${picked.fqdn}).`);
  await deps.ui.focusOperatorsView();
}
