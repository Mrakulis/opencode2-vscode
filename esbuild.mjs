// Dual-target build: extension host (node/cjs) + webview (browser/iife).
import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const watch = process.argv.includes("--watch");

const /** @type {import("esbuild").BuildOptions} */ extensionOptions = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["vscode"],
    outfile: "dist/extension.js",
    sourcemap: true,
    logLevel: "info",
  };

const /** @type {import("esbuild").BuildOptions} */ webviewOptions = {
    entryPoints: ["webview-src/main.tsx"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: "media/webview/main.js",
    sourcemap: false,
    minify: true,
    logLevel: "info",
  };

function copyAssets() {
  mkdirSync(dirname("media/webview/main.css"), { recursive: true });
  copyFileSync("webview-src/styles.css", "media/webview/main.css");
}

try {
  if (watch) {
    const [ext, web] = await Promise.all([
      context(extensionOptions),
      context(webviewOptions),
    ]);
    copyAssets();
    await Promise.all([ext.watch(), web.watch()]);
    console.log("[esbuild] watching extension + webview...");
  } else {
    await Promise.all([build(extensionOptions), build(webviewOptions)]);
    copyAssets();
    console.log("[esbuild] build complete");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
