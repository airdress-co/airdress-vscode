# Changelog

## [0.3.0](https://github.com/airdress-co/airdress-vscode/compare/v0.2.0...v0.3.0) (2026-09-05)


### Features

* **auth:** airdress.auth.authorizeBase setting for the branded sign-in entry ([836eebe](https://github.com/airdress-co/airdress-vscode/commit/836eebed013ebd4d0fe567eb2bafd6a3b34a15e0))
* **auth:** airdress.auth.route setting to force the loopback sign-in route ([b6cc8aa](https://github.com/airdress-co/airdress-vscode/commit/b6cc8aad7278bb594509516645985d32681eea45))


### Bug Fixes

* **apply:** surface the operator's {error, path} rejection shape as anchored diagnostics ([ca3f6a8](https://github.com/airdress-co/airdress-vscode/commit/ca3f6a84bc3fc89b04a9ef7c48c734d9e37a5d3a))
* **auth:** send the bare registered redirect_uri to the IdP ([f4ea286](https://github.com/airdress-co/airdress-vscode/commit/f4ea286c591cbda06392cc82a9aebe27beed7a68))
* **tree:** decode live operator response shapes; generate API types from the contract ([f42965f](https://github.com/airdress-co/airdress-vscode/commit/f42965fad402b6dbefd8b316f5007a14229c5ae7))

## [0.2.0](https://github.com/airdress-co/airdress-vscode/compare/v0.1.0...v0.2.0) (2026-09-04)

### Features

- first-contact connect flow and brand activity-bar mark ([256df93](https://github.com/airdress-co/airdress-vscode/commit/256df939a6bcc7a2ab2c5a49193923dffe0104d5))

## [0.1.0](https://github.com/airdress-co/airdress-vscode/compare/v0.0.2...v0.1.0) (2026-09-04)

### Features

- break-glass status-bar indicator, with no mint path by design ([e74d151](https://github.com/airdress-co/airdress-vscode/commit/e74d151addd09e8b4aa403ab239438b4b07d55ff))
- principal administration — create, revoke, metadata, identity bind ([81cbcdf](https://github.com/airdress-co/airdress-vscode/commit/81cbcdf61def40861d75d9b1d1b0ce79edf2ea27))
- split the sidebar into Operators, Resources and Principals views, add scoped apply ([e3d1d14](https://github.com/airdress-co/airdress-vscode/commit/e3d1d143ba2179a1b92686daf6accf8c8d037929))
- two-axis operator health with bounded polling ([f3db8e6](https://github.com/airdress-co/airdress-vscode/commit/f3db8e6fa161209a25d751b415158c3ca1e5a56a))
- workspace drift detection over an explicit manifest mapping ([d68db0a](https://github.com/airdress-co/airdress-vscode/commit/d68db0aeca9001fb02cf94df69fe69e1bd7371fb))

### Bug Fixes

- restructure a test needle the spell checker rejects ([26ad9ed](https://github.com/airdress-co/airdress-vscode/commit/26ad9ed0334d32d515685fd397471e1c8bdf00f4))
- reword a term the spell checker rejects ([eeea655](https://github.com/airdress-co/airdress-vscode/commit/eeea655ad0164d6bc9ad5c456a9b698dc0fc9662))
- reword and restructure terms the CI spell checker rejects ([7be98ed](https://github.com/airdress-co/airdress-vscode/commit/7be98edf87ebbe464c5239d6aff20a22e9c8f2ef))

## 0.0.2 — 2026-09-04

- Marketplace listing inherits the canonical Airdress brand: icon
  (`media/publisher-icon-128x128.png`, synced from `airdress-ops`
  `brand/wordmark/dist/` via `just brand-sync`), dark gallery banner on
  `void` (#111110), voice-compliant description and README.

## 0.0.1 — 2026-09-04

- Rehearsal release. Full v1 feature set: ZITADEL PKCE + opaque-bearer
  auth, SecretStorage credentials, FQDN-validated profiles, schema-
  validated manifest editing with diff-then-apply, read-only resource
  tree. Published to the VS Code Marketplace via OIDC (no stored
  credentials).
