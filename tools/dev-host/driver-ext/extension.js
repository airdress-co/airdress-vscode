// Dev-host driver: NO network listener. Watches a private state
// directory (mode 0700, this user only) for `cmd-*.json` files, runs
// vscode.commands.executeCommand for each, writes `res-*.json`, deletes
// the request. Nothing a browser page or another user can reach.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
let DIR;
function activate(context) {
  DIR = process.env.AIRDRESS_DEV_DRIVER_DIR || path.join(context.extensionPath, "..", "..", "..", ".dev-host", "driver-io");
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const seen = new Set();
  const tick = async () => {
    let files;
    try { files = fs.readdirSync(DIR); } catch { return; }
    for (const f of files) {
      if (!f.startsWith("cmd-") || !f.endsWith(".json") || seen.has(f)) continue;
      seen.add(f);
      const id = f.slice(4, -5);
      const out = path.join(DIR, `res-${id}.json`);
      let payload;
      try { payload = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); }
      catch (e) { fs.writeFileSync(out, JSON.stringify({ error: String(e) })); continue; }
      try {
        if (payload.diagnostics) {
          fs.writeFileSync(out, JSON.stringify(vscode.languages.getDiagnostics().flatMap(([uri, ds]) =>
            ds.map((d) => ({ uri: uri.toString(), message: d.message, range: [d.range.start.line, d.range.start.character] })))));
        } else if (payload.info) {
          fs.writeFileSync(out, JSON.stringify({
            tabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)),
            active: vscode.window.activeTextEditor?.document.uri.toString() ?? null,
            extensions: vscode.extensions.all.filter((e) => e.id.startsWith("airdress")).map((e) => ({ id: e.id, active: e.isActive })),
          }));
        } else {
          const p = vscode.commands.executeCommand(payload.command, ...(payload.args ?? []));
          const timeout = new Promise((r) => setTimeout(() => r({ pending: true }), 60000));
          const res = await Promise.race([p.then((r) => ({ result: r ?? null })), timeout]);
          p.catch((e) => fs.writeFileSync(out, JSON.stringify({ error: String(e && e.message || e) })));
          fs.writeFileSync(out, JSON.stringify(res));
        }
      } catch (e) { fs.writeFileSync(out, JSON.stringify({ error: String(e && e.message || e) })); }
      fs.unlinkSync(path.join(DIR, f));
    }
  };
  const timer = setInterval(() => void tick(), 300);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
module.exports = { activate, deactivate() {} };
