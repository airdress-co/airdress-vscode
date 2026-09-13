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
 * Exit codes:
 *   0 — synced (files rewritten; may be a no-op)
 *   1 — real failure (bad index shape, write error, …)
 *   2 — network unavailable / upstream unreachable; nothing written.
 *       CI treats 2 as "skip with notice", never as drift.
 *
 * `--check` compares instead of writing: every Kind the index lists
 * must have both twins present and byte-identical to its pinned
 * artifact. Exit 1 names each Kind that drifts or is missing; exit 0
 * when everything matches — and ALSO when upstream is unreachable,
 * with a loud notice, because a pre-commit hook must not block a
 * commit on a network flake. (The write path keeps exit 2 for that;
 * CI reads it.) A Kind the operator publishes that this repo has never
 * seen is reported as missing, not skipped: that is exactly the drift
 * a plain `git diff` cannot see, because the file is untracked.
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

const CHECK = process.argv.includes("--check");
// Unreachable upstream: the write path says so with exit 2 (CI skips
// with a notice); the check path passes, because a hook that blocks a
// commit on a network flake gets disabled, and then catches nothing.
const UNREACHABLE_EXIT = CHECK ? 0 : 2;

async function fetchOrExit2(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    console.error(`sync-schemas: NETWORK UNAVAILABLE fetching ${url}`);
    console.error(`sync-schemas: ${err instanceof Error ? err.message : err}`);
    if (CHECK) console.error("sync-schemas: check SKIPPED, not drift");
    process.exit(UNREACHABLE_EXIT);
  }
  if (!res.ok) {
    // An upstream 5xx (or an edge 404 during a publish) is a flake from
    // this repo's point of view, not drift — skippable, but loud.
    console.error(`sync-schemas: UPSTREAM UNAVAILABLE ${res.status} ${url}`);
    if (CHECK) console.error("sync-schemas: check SKIPPED, not drift");
    process.exit(UNREACHABLE_EXIT);
  }
  return Buffer.from(await res.arrayBuffer());
}

const index = JSON.parse((await fetchOrExit2(INDEX_URL)).toString("utf8"));
if (!Array.isArray(index.kinds) || index.kinds.length === 0) {
  console.error("sync-schemas: index.json carries no kinds — refusing to sync");
  process.exit(1);
}

const drift = [];
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
    const rel = path.relative(REPO_ROOT, target);
    if (CHECK) {
      const state = !fs.existsSync(target)
        ? "MISSING"
        : fs.readFileSync(target).equals(bytes)
          ? null
          : "DRIFT";
      if (state) {
        drift.push(`${state} ${rel} (published: ${pinnedUrl})`);
      }
      continue;
    }
    fs.writeFileSync(target, bytes);
    console.log(`sync-schemas: ${kind} <- ${pinnedUrl} -> ${rel}`);
  }
}

if (CHECK) {
  if (drift.length > 0) {
    console.error(
      "sync-schemas: bundled schemas differ from the published pins:",
    );
    for (const line of drift) console.error(`  ${line}`);
    console.error(
      "sync-schemas: run `npm run sync:schemas`, register any new Kind (see CONTRIBUTING.md), and stage the result",
    );
    process.exit(1);
  }
  console.log(
    `sync-schemas: ${index.kinds.length} kinds match their published pins`,
  );
}
