#!/usr/bin/env node
/**
 * Sync the bundled per-kind manifest schemas from the published,
 * version-pinned artifacts at schemas.airdress.co.
 *
 * For every kind listed in the operator schema index, the PINNED copy
 * (`.../<Kind>/v1/<operator-version>.json`) is downloaded — never the
 * floating alias — so a re-run without an upstream publish is
 * byte-for-byte idempotent. Each kind's bytes are written, identically,
 * to BOTH shipped locations:
 *
 *   src/manifests/schemas/<kind>.json          (bundled, imported by index.ts)
 *   schemas/<kind>.schema.json                 (editor associations)
 *
 * A test enforces that the two copies stay byte-identical; this script
 * is the only thing that should ever write them. The fleet TOML schema
 * (schemas/fleet-manifest.schema.json) is hand-authored, validate-only,
 * and deliberately NOT synced. The envelope schema
 * (schemas/operator-manifest.schema.json) has no pinned artifact and is
 * not synced either.
 *
 * HAND-SEEDED, TEMPORARILY: `Function` (function.json /
 * function.schema.json) was written by hand from the operator's
 * contract because the operator has not published the kind yet. This
 * script rewrites only the kinds the index lists, so the seed is left
 * alone by a sync — and by CI's sync-check — until the operator's next
 * release publishes `Function`, after which a run of this script
 * replaces the seeded bytes with the published ones and the exception
 * ends. Do not add a second hand-seeded kind without the same note.
 *
 * Exit codes:
 *   0 — synced (files rewritten; may be a no-op)
 *   1 — real failure (bad index shape, write error, …)
 *   2 — network unavailable / upstream unreachable; nothing written.
 *       CI treats 2 as "skip with notice", never as drift.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_URL = "https://schemas.airdress.co/operator/index.json";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FETCH_TIMEOUT_MS = 30_000;

/** "InferencePoolMember" -> "inference-pool-member" */
function kebab(kind) {
  return kind.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

async function fetchOrExit2(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    console.error(`sync-schemas: NETWORK UNAVAILABLE fetching ${url}`);
    console.error(`sync-schemas: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  if (!res.ok) {
    // An upstream 5xx (or an edge 404 during a publish) is a flake from
    // this repo's point of view, not drift — skippable, but loud.
    console.error(`sync-schemas: UPSTREAM UNAVAILABLE ${res.status} ${url}`);
    process.exit(2);
  }
  return Buffer.from(await res.arrayBuffer());
}

const index = JSON.parse((await fetchOrExit2(INDEX_URL)).toString("utf8"));
if (!Array.isArray(index.kinds) || index.kinds.length === 0) {
  console.error("sync-schemas: index.json carries no kinds — refusing to sync");
  process.exit(1);
}

for (const entry of index.kinds) {
  const { kind, pinned_url: pinnedUrl } = entry;
  if (typeof kind !== "string" || typeof pinnedUrl !== "string") {
    console.error(
      `sync-schemas: malformed index entry: ${JSON.stringify(entry)}`,
    );
    process.exit(1);
  }
  const bytes = await fetchOrExit2(pinnedUrl);
  JSON.parse(bytes.toString("utf8")); // refuse to write a non-JSON body

  const targets = [
    path.join(REPO_ROOT, "src/manifests/schemas", `${kebab(kind)}.json`),
    path.join(REPO_ROOT, "schemas", `${kebab(kind)}.schema.json`),
  ];
  for (const target of targets) {
    fs.writeFileSync(target, bytes);
    console.log(
      `sync-schemas: ${kind} <- ${pinnedUrl} -> ${path.relative(REPO_ROOT, target)}`,
    );
  }
}
