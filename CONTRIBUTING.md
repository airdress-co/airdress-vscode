# Contributing

Automated checks (lint, typecheck, test, package) are in the README's
Development section. This covers running the extension itself while you
work on it.

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
