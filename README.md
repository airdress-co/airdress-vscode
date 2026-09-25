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
- **One airdress at a time, in view.** The _Airdress_ view at the top of
  the sidebar says which operator is current, whether it answers, and
  whether you are signed in — as facts, not guesses: a dead session
  shows **needs sign-in** before you run anything, and _Sign in again_
  refreshes that profile in place. Every command acts on the current
  airdress without asking; switching is one click, and every write
  still names its target profile and FQDN in its confirm.
- **Every resource, editable.** Create, edit and delete any Kind the
  operator serves — `InferencePoolMember`, `Schedule`, `Function` — from
  the tree, with no manifest file involved. The panel draws its form
  from the operator's published schema for that Kind and falls back to
  a raw-YAML editor when there is none, so a Kind the extension has
  never heard of is still reachable. One write path (`/v1/apply`), a
  create that refuses to overwrite an existing name silently, a
  `resourceVersion` round-trip so a stale edit is reloaded rather than
  clobbering someone else's, and a type-the-name confirm before any
  delete. "Airdress: New Resource…" on the Resources view; the pencil
  and the context menu on every row.
- **Functions, configured.** The same panel, with what only a Function
  has: the `POST /fn/<name>` trigger with a test invoke, and the bundle
  on the operator's disk. Open it from a Function row's gear, or draft
  one with "Airdress: New Function…".
- **Function source, edited where it runs.** A source Function's row
  lists the files it serves; click one to read it. "Edit Function
  Source" copies them into a folder, and every save there is checked by
  the operator's own dry run — a refusal lands as a marker on the line
  it names. "Airdress: Publish Function Source" stores a version based
  on the one you read; if the function moved meanwhile, you are shown
  the difference, never retried over it. A function whose source is
  imported by configuration management says so and stays read-only.
- **Deploy, in one step.** "Airdress: Deploy Function" takes the
  folder you are editing to a function serving it: the operator checks
  it unsigned, its digest must match the editor's, you confirm once,
  and only then is it signed, published and made to run — by promote,
  which changes nothing but the version, for a function that exists, or
  by one apply showing the whole grant, for a new one. It then waits
  until the function reports the new version loaded. The first Deploy
  offers to make this workstation's signing key, kept in the operating
  system's keychain ("Airdress: Export Signing Key…" writes it out for
  the command line).
- **Start from working code.** "+" on the Function kind asks: from a
  template, a blank source function, or a bundle (the form). The first
  two write the operator's files into a folder with a `function.yaml`
  beside them, and offer Deploy.
- **Who may deploy, on the function.** A source Function's row shows
  its signers and who signed what runs. "Allow Another Signer…" (a key,
  this workstation, or an enrolled machine) and "Remove Signer…" are
  each their own apply, shown before it is sent — never part of a
  Deploy.
- **It knows when you are in a function.** Open any file under a
  folder whose `function.json` is a source function and the editor
  shows that function's tooling: Deploy and Validate in the editor
  title (Logs, Versions and "Show on the Operator" under its "…"), a
  status bar item with the version the operator runs — marked when it
  is not the one `function.yaml` names, when it did not load, or when
  your files differ from it — and lenses on `function.json`, the entry
  file and `function.yaml`. The function is found from the repository
  itself: `function.yaml` names it, and `airdress.functions.yaml` (the
  map the CLI and the GitHub Action read) names its manifest and
  operator, so a repository deployed from CI needs no setup and gets no
  extra files. `function.json` and the map file are checked against
  their schemas as you type, and each save runs the operator's dry run
  (`airdress.functions.validateOnSave`, on by default). Changing who may
  sign also writes the set into the committed `function.yaml`.
- **Templates, with the grant left to you.** "Airdress: New Function
  from Template…" lists the operator's catalogue. A template's options
  are a form (a secret is named, never pasted); the grants it needs are
  shown as YAML to add, and never written for you. Or fork its code
  into a folder, as ordinary source that no longer refers to it.

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
- `src/functions/` — function source and templates: `wire.ts` the
  routes, `local.ts` the folder and the signature, `source.ts` the
  editing loop, `diagnostics.ts` refusals as markers, `templates.ts`
  the form and the grant suggestion (pure), `templatePanel.ts` +
  `browser/templateForm.ts` → `dist/templateForm.js`; `deploy.ts` the
  Deploy loop and `stops.ts` its stop codes (held to
  `deploy-stops.txt`), `createPick.ts` the "+", `signingKey.ts` the
  keychain key, `signers.ts` + `signerFlows.ts` the signer set,
  `functionManifest.ts` the live manifest and `function.yaml`.
- `src/selector/` — the Airdress view: `protocol.ts` shared by both
  bundles, `controller.ts` behind a host seam, `view.ts` the
  WebviewView, `browser/main.ts` → `dist/selector.js`.
- `src/webview/` — the resource panel, one for every Kind: `protocol.ts`
  and `form.ts` are shared by both bundles; `controller.ts` is the state
  machine behind a host seam; `panel.ts` is the extension side;
  `browser/main.ts` is the webview side (`dist/webview.js`, its own
  DOM tsconfig); `kinds.ts` is the closed table of per-Kind extras
  (today: `Function`). Layout lives in `media/function-panel.css` only.
- `schemas/fleet-manifest.schema.json` — fleet VM TOML manifest, validate-only.
- `schemas/<kind>.schema.json` + `src/manifests/schemas/<kind>.json` —
  byte-identical twins of the operator's published per-Kind schemas,
  written only by `npm run sync:schemas`. Adding a Kind is described in
  [CONTRIBUTING.md](https://github.com/airdress-co/airdress-vscode/blob/main/CONTRIBUTING.md).

## License

MIT — see [LICENSE](https://github.com/airdress-co/airdress-vscode/blob/main/LICENSE).
