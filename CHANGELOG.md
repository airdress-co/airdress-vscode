# Changelog

## Unreleased

### Features

- `Function` is a known kind: validated on apply, diffed against live, drift-scanned,
  rendered as known in the Resources view. Its schema is hand-seeded from
  the operator's contract until the operator publishes it.
- Function configuration panel (the extension's first webview): overview
  with phase and conditions, bundle, permissions, limits, the fixed
  `POST /fn/<name>` trigger with a test invoke, disable and delete. The
  form is derived from the bundled schema; Apply and Diff reuse the
  existing manifest commands. Opened from a Function row's gear
  ("Airdress: Configure Function") or from "Airdress: New Function…".

## [0.5.0](https://github.com/airdress-co/airdress-vscode/compare/v0.4.0...v0.5.0) (2026-09-16)


### Features

* **tree:** revoke an enrollment from the Enrollments node ([4cdbd79](https://github.com/airdress-co/airdress-vscode/commit/4cdbd797ca8ade0e2896fa22740a65a776e9718f))


### Bug Fixes

* **tree:** an empty enrollments listing says so instead of expanding to nothing ([42fbf7c](https://github.com/airdress-co/airdress-vscode/commit/42fbf7c23ef46d978547c19e20bf9faeedac7165))

## [0.4.0](https://github.com/airdress-co/airdress-vscode/compare/v0.3.0...v0.4.0) (2026-09-13)


### Features

* **dev:** connect an airdress by FQDN, with the flow's own words returned ([eaf7450](https://github.com/airdress-co/airdress-vscode/commit/eaf745030590e8c9d777990d720ed1176ca07b3e))


### Bug Fixes

* **panel:** a taken apply closes its document; sign-out takes an explicit target ([d1271ac](https://github.com/airdress-co/airdress-vscode/commit/d1271ac25bc884b200f30a74fd35c24bec8d22be))

## [0.3.0](https://github.com/airdress-co/airdress-vscode/compare/v0.2.0...v0.3.0) (2026-09-13)


### Features

* **auth:** airdress.auth.authorizeBase setting for the branded sign-in entry ([836eebe](https://github.com/airdress-co/airdress-vscode/commit/836eebed013ebd4d0fe567eb2bafd6a3b34a15e0))
* **auth:** airdress.auth.route setting to force the loopback sign-in route ([b6cc8aa](https://github.com/airdress-co/airdress-vscode/commit/b6cc8aad7278bb594509516645985d32681eea45))
* **auth:** credential state is a reported fact, and "Sign In Again" refreshes a profile in place ([d7b222e](https://github.com/airdress-co/airdress-vscode/commit/d7b222e3a893135563619585a85a3d155ec984fa))
* **functions:** a configuration panel drawn from the Function schema ([21de97c](https://github.com/airdress-co/airdress-vscode/commit/21de97cb9f5bc4aa2a23651aefac56c6a26f3f7c))
* **functions:** configure from a Function row, or draft a new one ([ab71e5b](https://github.com/airdress-co/airdress-vscode/commit/ab71e5babdd3b96003a88da95cb8f9d74a111c12))
* **manifests:** Function is a known kind — validated, diffable, drift-scannable ([2ffb4d0](https://github.com/airdress-co/airdress-vscode/commit/2ffb4d0cf33745933a5f2418fc3b656b6260b5d6))
* **panel:** a development-only drive seam, and what driving it found ([cc69538](https://github.com/airdress-co/airdress-vscode/commit/cc69538aafa7ed6c71779ef7e613afcf9fb8ef99))
* **profiles:** the active airdress is the standing target; one signed-in row per airdress ([0d9923d](https://github.com/airdress-co/airdress-vscode/commit/0d9923daf0c166fb1bd3b58771aa23ae090cee89))
* **selector:** a standing Airdress view — which airdress, whether it answers, whether you are signed in ([d421edd](https://github.com/airdress-co/airdress-vscode/commit/d421edd5b4044326ba399f02b34fdfdd5e0946d6))
* **spec-088:** sync the published Function schema and follow it ([27abe94](https://github.com/airdress-co/airdress-vscode/commit/27abe94692329b42720212d72d9fe1e64346192d))
* **spec-093:** create, edit and delete any Kind from the resource tree ([88d8345](https://github.com/airdress-co/airdress-vscode/commit/88d83452b0e4a3b60d50f351b16f12811a09233c))


### Bug Fixes

* **apply:** POST /v1/apply as JSON — the operator's handler never took YAML ([a48298f](https://github.com/airdress-co/airdress-vscode/commit/a48298fc3b37b8386ee617f8e146fbd09e778dd4))
* **apply:** surface the operator's {error, path} rejection shape as anchored diagnostics ([ca3f6a8](https://github.com/airdress-co/airdress-vscode/commit/ca3f6a84bc3fc89b04a9ef7c48c734d9e37a5d3a))
* **auth:** one refresh exchange in flight per profile ([160c43c](https://github.com/airdress-co/airdress-vscode/commit/160c43c65c7a981a4eaac76d9549d5fd2ee69631))
* **auth:** send the bare registered redirect_uri to the IdP ([f4ea286](https://github.com/airdress-co/airdress-vscode/commit/f4ea286c591cbda06392cc82a9aebe27beed7a68))
* **panel:** a post after dispose is dropped, not thrown ([e1ae14b](https://github.com/airdress-co/airdress-vscode/commit/e1ae14b1fe58a07f173a72caf3b8d9d5ff00d1b4))
* **profiles:** connecting an airdress you already have refreshes it — no twin row ([b3c9945](https://github.com/airdress-co/airdress-vscode/commit/b3c994515a0727a9a8bac0ecbdc0f4b495f62a38))
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
