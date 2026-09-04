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

## Layout

- `src/extension.ts` — activation: registers providers; no network calls.
- `src/auth/` — ZITADEL code+PKCE, opaque-bearer entry, SecretStorage wrapper.
- `src/profiles/` — profile model, globalState store, quick-pick.
- `src/api/` — fetch wrapper + RFC 7807 parsing; `generated/` is checked in.
- `src/manifests/` — schemas, Ajv diagnostics, live-diff flow.
- `src/tree/` — resources tree provider.
- `schemas/fleet-manifest.schema.json` — fleet VM TOML manifest, validate-only.

## License

MIT — see [LICENSE](https://github.com/airdress-co/airdress-vscode/blob/main/LICENSE).
