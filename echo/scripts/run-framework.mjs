import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";
import fs from "node:fs";

// Windows can reject GetFinalPathNameByHandle for otherwise readable files.
// Node's portable resolver follows the same links using ordinary file reads.
if (process.platform === "win32") {
  const nativeRealpath = fs.realpathSync.native;
  fs.realpathSync.native = (path, options) => {
    try { return nativeRealpath(path, options); }
    catch (error) {
      if (error.code !== "EPERM") throw error;
      return fs.realpathSync(path, options);
    }
  };
}

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../node_modules/vite/bin/vite.js"
  : "../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
