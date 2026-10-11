#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifestPath = fileURLToPath(new URL("package.json", root));
const lockPath = fileURLToPath(new URL("package-lock.json", root));
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function valid(version) {
  return typeof version === "string" && stableVersion.test(version)
    && version.split(".").every(part => Number.isSafeInteger(Number(part)));
}

try {
  const [command, version, ...extra] = process.argv.slice(2);
  if (extra.length || !(command === "check" && version === undefined || command === "set" && valid(version))) {
    throw new Error("Usage: node scripts/version.mjs check | set X.Y.Z (stable version)");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!lock.packages?.[""]) throw new Error("Lockfile must contain the root package.");
  if (command === "set") {
    manifest.version = lock.version = lock.packages[""].version = version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  }
  if (!valid(manifest.version) || manifest.version !== lock.version || manifest.version !== lock.packages[""].version) {
    throw new Error("Package and lockfile versions disagree or are invalid. Run npm run version:set -- X.Y.Z.");
  }
  console.log(`Version ${manifest.version} is consistent across package.json and package-lock.json.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
