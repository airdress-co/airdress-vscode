# airdress-vscode

VS Code / Open VSX extension for airdress operators: operator profiles,
manifest validation, and resource browsing (SPEC-057).

Status: scaffold. Commands, the view container, configuration, and
schema associations are registered; behaviour lands in Phase 6
(`TODO(SPEC-057 T6-NN)` markers throughout `src/`).

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
- `schemas/fleet-manifest.schema.json` — SPEC-047 TOML manifest, validate-only.

## License

MIT — see [LICENSE](https://github.com/airdress-co/airdress-vscode/blob/main/LICENSE).
