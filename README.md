# Airdress for VS Code

**Your Airdress operators, in your editor.**

Sign in once. Switch operators like you switch branches. Edit manifests
with schema validation and see the diff against what is actually running
— before anything is applied.

- **One sign-in.** OAuth 2.0 with PKCE in your system browser. Tokens
  live in your OS keychain, never in a settings file.
- **Every operator, one list.** Profiles are addressed by Airdress name
  (`<name>.a.airdr.es`) — switch from the status bar, no ambient default,
  no applying to the wrong box.
- **Manifests you can trust.** Schema validation as you type, a live
  diff against the operator, and an apply that names its target before
  it runs. Saving a file never applies anything.
- **See what is running.** A read-only resource tree: pools, resources,
  status — administrative metadata only, by design.
- **Functions, configured.** A panel for each hosted function — bundle,
  permissions, limits, the `POST /fn/<name>` trigger with a test
  invoke, disable and delete. The form is drawn from the operator's own
  manifest schema, and Apply goes through the same confirm-then-apply
  flow as a file. Open it from a Function row's gear, or draft one with
  "Airdress: New Function…".

Works in VS Code and, via Open VSX, in VSCodium and other open builds.

Marketplace note: any images added to this README must use absolute
URLs — relative ones render broken on the Marketplace listing.

## Development

```sh
npm ci
npm run compile     # esbuild bundle -> dist/extension.js
npm run typecheck   # tsc --noEmit
npm run lint        # eslint + prettier --check
npm test            # @vscode/test-electron (headless: xvfb-run -a npm test)
npm run package     # vsce package -> airdress-vscode-<version>.vsix
```

Operator API types in `src/api/generated/` are generated from the
operator's OpenAPI contract and committed (no build-time cross-repo
reach). To regenerate against a newer contract:
`OPENAPI_PATH=/path/to/openapi.yaml OPENAPI_SHA=<contract commit> npm run generate:api`.

To run the extension itself while you work on it — interactively with
F5, or isolated from your daily profile via the command line — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Layout

- `src/extension.ts` — activation: registers providers; no network calls.
- `src/auth/` — ZITADEL code+PKCE, opaque-bearer entry, SecretStorage wrapper.
- `src/profiles/` — profile model, globalState store, quick-pick.
- `src/api/` — fetch wrapper + RFC 7807 parsing; `generated/` is checked in.
- `src/manifests/` — schemas, Ajv diagnostics, live-diff flow.
- `src/tree/` — resources tree provider.
- `src/webview/` — the Function configuration panel: `protocol.ts` and
  `form.ts` are shared by both bundles; `controller.ts` is the state
  machine behind a host seam; `panel.ts` is the extension side;
  `browser/main.ts` is the webview side (`dist/webview.js`, its own
  DOM tsconfig). Layout lives in `media/function-panel.css` only.
- `schemas/fleet-manifest.schema.json` — fleet VM TOML manifest, validate-only.
- `schemas/function.schema.json` — hand-seeded from the operator's
  contract until the operator publishes the kind; `npm run sync:schemas`
  then replaces it (see the note in `scripts/sync-schemas.mjs`).

## License

MIT — see [LICENSE](https://github.com/airdress-co/airdress-vscode/blob/main/LICENSE).
