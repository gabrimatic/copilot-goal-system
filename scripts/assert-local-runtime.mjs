#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const vscodePackage = await readJson("vscode-extension/package.json");
const vscodePackageLock = await readJson("vscode-extension/package-lock.json");
const checkScript = String(packageJson.scripts?.check || "");
const removedServerFile = path.join("adapters", "vscode-chat", `${String.fromCharCode(109, 99, 112)}-server.mjs`);
const forbiddenSdkPackage = "@modelcontextprotocol/sdk";

if (await exists(removedServerFile)) {
  fail(`${removedServerFile} must not exist; the goal system uses local commands and direct tools.`);
}

for (const [name, manifest] of [
  ["package.json", packageJson],
  ["vscode-extension/package.json", vscodePackage],
]) {
  const dependencies = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
  if (dependencies[forbiddenSdkPackage]) {
    fail(`${name} must not depend on ${forbiddenSdkPackage}.`);
  }
}

for (const [name, lockfile] of [
  ["package-lock.json", packageLock],
  ["vscode-extension/package-lock.json", vscodePackageLock],
]) {
  if (lockfile.packages?.[`node_modules/${forbiddenSdkPackage}`]) {
    fail(`${name} must not include ${forbiddenSdkPackage}.`);
  }
}

if (new RegExp(`${String.fromCharCode(109, 99, 112)}-server\\.mjs`).test(checkScript)) {
  fail("npm run check must not reference the removed server entrypoint.");
}
