import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const echoDir = path.join(root, "echo");

const dirsToCopy = ["app", "lib", "components", "db", "hooks"];
for (const dir of dirsToCopy) {
  const src = path.join(echoDir, dir);
  const dest = path.join(root, dir);
  if (fs.existsSync(src)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}

const filesToCopy = [
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "cloudflare-env.d.ts",
  "next-env.d.ts",
  "components.json",
];
for (const file of filesToCopy) {
  const src = path.join(echoDir, file);
  const dest = path.join(root, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

const echoPublic = path.join(echoDir, "public");
const rootPublic = path.join(root, "public");
if (fs.existsSync(echoPublic)) {
  fs.mkdirSync(rootPublic, { recursive: true });
  // Remove legacy root public/index.html so Next.js App Router `/` serves the root route
  const legacyIndex = path.join(rootPublic, "index.html");
  if (fs.existsSync(legacyIndex)) {
    fs.rmSync(legacyIndex, { force: true });
  }
  fs.cpSync(echoPublic, rootPublic, { recursive: true, force: true });
}

// Remove legacy root api/ folder during Next.js build so /api/* routes are handled by app/api/*
const legacyApi = path.join(root, "api");
if (fs.existsSync(legacyApi)) {
  fs.rmSync(legacyApi, { recursive: true, force: true });
}

console.log("[vercel-sync] Synced echo Next.js application to repository root.");
