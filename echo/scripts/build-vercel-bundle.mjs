import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("../node_modules/esbuild");

const echoRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(echoRoot, "..");

// 1. Copy static build output from echo/.next into root public/
const rootPublic = path.join(repoRoot, "public");
fs.mkdirSync(rootPublic, { recursive: true });

// Copy echo/public/* -> public/
fs.cpSync(path.join(echoRoot, "public"), rootPublic, { recursive: true, force: true });

// Copy echo/.next/static -> public/_next/static
const nextStaticDest = path.join(rootPublic, "_next", "static");
fs.rmSync(nextStaticDest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(nextStaticDest), { recursive: true });
fs.cpSync(path.join(echoRoot, ".next", "static"), nextStaticDest, { recursive: true });

// Copy echo/.next/server/app/index.html -> public/index.html
fs.copyFileSync(
  path.join(echoRoot, ".next", "server", "app", "index.html"),
  path.join(rootPublic, "index.html")
);

// 2. Bundle echo/scripts/vercel-api-entry.ts -> api/index.js
const apiDir = path.join(repoRoot, "api");
fs.mkdirSync(apiDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(echoRoot, "scripts", "vercel-api-entry.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(apiDir, "index.js"),
  external: ["node:sqlite"],
  alias: {
    "cloudflare:workers": path.join(echoRoot, "lib", "server", "cloudflare-workers-shim.ts"),
    "@": echoRoot,
  },
  footer: {
    js: "if (typeof module !== 'undefined' && module.exports && module.exports.default) { module.exports = module.exports.default; }",
  },
  logLevel: "info",
});

console.log("[build-vercel-bundle] Successfully built public/index.html, public/_next/static, and api/index.js!");
