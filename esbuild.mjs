import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  logLevel: "info",
};

/** The extension host bundle. */
const extension = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
};

/**
 * The Function panel's browser bundle. Loaded by the webview through a
 * nonce'd <script>; it shares src/webview/{protocol,form}.ts with the
 * extension bundle and imports nothing from `vscode` or Node.
 */
const webview = {
  ...shared,
  entryPoints: ["src/webview/browser/main.ts"],
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extension),
    esbuild.context(webview),
  ]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
