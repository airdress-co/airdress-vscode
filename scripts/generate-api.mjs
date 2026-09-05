#!/usr/bin/env node
/**
 * Regenerate src/api/generated/operator.ts from the operator API contract.
 *
 * The contract file is private, so the generated output is committed —
 * there is no build-time cross-repo reach. To regenerate, place a copy
 * of the contract locally and run:
 *
 *   OPENAPI_PATH=/path/to/openapi.yaml OPENAPI_SHA=<contract commit> npm run generate:api
 *
 * OPENAPI_PATH defaults to /tmp/openapi.yaml. OPENAPI_SHA (optional)
 * is recorded in the header so reviewers can pin the source revision.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const source = process.env.OPENAPI_PATH ?? "/tmp/openapi.yaml";
const sha = process.env.OPENAPI_SHA ?? "unknown";
const out = new URL("../src/api/generated/operator.ts", import.meta.url)
  .pathname;

execFileSync("npx", ["openapi-typescript", source, "-o", out], {
  stdio: "inherit",
});

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Generated from the operator API contract at commit ${sha}
 * by \`npm run generate:api\` (scripts/generate-api.mjs).
 */
`;
// The contract is private; its doc comments may cite internal process
// identifiers that must not appear in this public repo. Redact them.
const sanitized = readFileSync(out, "utf8").replace(
  /\b(SPEC|RB|RDR)-[0-9]+\b/g,
  "[internal]",
);
writeFileSync(out, header + sanitized);
console.log(`wrote ${out} (contract commit ${sha})`);
