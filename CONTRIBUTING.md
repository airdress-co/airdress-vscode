# Contributing

Automated checks (lint, typecheck, test, package) are in the README's
Development section. This covers running the extension itself while you
work on it, and how a new resource Kind reaches it.

## Adding a Kind

Resource CRUD is schema-driven. The panel that creates, edits and
deletes a resource draws its form from the Kind's published JSON Schema
and applies through the one `POST /v1/apply` path, so **no code in
`src/webview/` or `src/tree/` names a Kind**. A Kind the extension has
never seen still gets the panel — in raw-YAML mode, with a notice that
validation is off — the moment the operator lists it under
`GET /v1/kinds`.

To ship _validation_ for a new Kind once the operator publishes its
schema at `schemas.airdress.co/operator/<Kind>/v1.json`:

- `npm run sync:schemas` — writes the pinned bytes to both twins,
  `src/manifests/schemas/<kind>.json` and `schemas/<kind>.schema.json`.
  Never edit either by hand; a test holds them byte-identical.
- `src/manifests/schemas/index.ts` — one import, one entry in
  `bundledSchemas()`.
- `schemas/operator-manifest.schema.json` — one `if`/`then` arm so the
  editor association for `*.airdress.yaml` dispatches on `kind`.

That is the whole change. The tests derive their Kind lists from
`bundledSchemas()`, so the twin check and the envelope-routing check
cover the new Kind without being told.

Only if the Kind carries an affordance plain CRUD does not — the way
`Function` has an invoke trigger and a bundle on disk — does it get an
entry in `src/webview/kinds.ts`. That table is deliberately closed and
hand-written; three Kinds do not need a plugin system.

## Interactive: press F5

Open this folder in VS Code and press **F5** ("Run Extension"). That
starts the esbuild watcher as a background task, waits for the first
build, and launches a second VS Code window — the Extension
Development Host — with this build of `airdress.airdress-vscode`
loaded from `dist/`. Edit source, save, and reload that window
(`Developer: Reload Window`, usually `Ctrl+R` / `Cmd+R`) to pick up the
rebuild; the watcher keeps running in the background the whole time.

This window shares your regular VS Code profile — same settings, same
OS keychain — so anything the extension writes via `SecretStorage`
(a signed-in profile's refresh token, for instance) lands in your real
keychain under this extension's identifier. Fine for normal
day-to-day development; sign out or use the isolated form below if you
want to keep that out of your daily profile entirely.

## Isolated: from the command line

Useful for exercising the extension without touching your main profile
at all — a clean slate for testing sign-in and profile-switching from
scratch, or for driving it from a script.

```sh
npm run watch &   # keep dist/ rebuilding in the background

code \
  --user-data-dir=/path/to/some/scratch/dir/data \
  --extensions-dir=/path/to/some/scratch/dir/ext \
  --extensionDevelopmentPath="$PWD" \
  --new-window
```

**Use `--flag=value` for every flag, not `--flag value`.** At least on
the Linux snap build of VS Code, the wrapper script mis-parses
space-separated pairs for `--user-data-dir` and `--extensions-dir`: it
silently drops the value from its flag and appends it as a bare
trailing path instead, which VS Code then treats as something to open
rather than as your isolation directory. The failure is silent — the
window still opens and the extension still loads, just against your
_real_ profile instead of the scratch one. The `--flag=value` form
sidesteps the wrapper entirely and is unaffected. If you want to
confirm which one actually happened, check the running process's
command line (`ps aux | grep extensionDevelopmentPath`) — every flag
should show its value attached, none of them bare at the end.

To confirm the extension actually activated inside a given window,
look for its activation line in that profile's extension host log:

```sh
grep airdress "<user-data-dir>/logs/"*/window*/exthost/exthost.log
```

## Driving the dev host from a script — the walls

`npm test` runs headlessly under `@vscode/test-electron` and covers the
controller through the `ResourcePanelHost` seam, so most of the panel's
behaviour is provable without a window. When you do need the window,
these are the walls, measured on 2026-09-12:

- **Without the isolation flags, `code` forwards to the running
  instance.** A bare `code --extensionDevelopmentPath=.` with a VS Code
  already open lands in your everyday window with the extension
  _inactive_ (`"active": false` in the running-extensions view). It
  looks like a broken activation event; it is a plain window. The
  isolated form above is the fix — and it is also why there is **one
  dev host at a time**: a second `code` against the same
  `--user-data-dir` forwards to the first, so two drivers "sharing" a
  host are one driver and one confused observer.

- **Drive commands by file drop, not by a listener.** To run
  `vscode.commands.executeCommand` from outside the window, the shape
  that works is a tiny second dev extension that watches a private
  scratch directory for `cmd-*.json`, executes the command, and writes
  the reply beside it. It reaches palette commands _and_ quick-pick
  acceptance (`workbench.action.acceptSelectedQuickOpenItem`) with no
  input injection, and a command that takes a tree node can be handed
  one as JSON. The same driver with an HTTP control port is an RCE
  surface; do not rebuild it that way.

- **What it cannot reach:** the text of an open quick-pick, and the
  webview's own form. `executeCommand` opens the panel; nothing outside
  the window types into it.

- **The sign-in wall cannot be driven on this OS.** The "open external
  website?" modal and the browser tab behind it are OS-drawn; nothing
  short of a portal grant clicks them on Wayland, and `executeCommand`
  cannot dismiss them. Anything past sign-in is verified in the test
  suite by stubbing the `OidcDriver` with a canned token, not on the
  window.

- **Screenshots go through the xdg portal**, and the first call blocks
  on a permission dialog until approved once per session.
