#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function readText(relativePath) {
  return await readFile(path.join(root, relativePath), "utf8");
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function checkLockVersion(lock, filePath, expectedVersion) {
  if (lock.version && lock.version !== expectedVersion) {
    fail(`Version mismatch: ${filePath} is ${lock.version}, package.json is ${expectedVersion}.`);
  }
  const rootPackage = lock.packages?.[""];
  if (rootPackage?.version && rootPackage.version !== expectedVersion) {
    fail(`Version mismatch: ${filePath} packages[""].version is ${rootPackage.version}, package.json is ${expectedVersion}.`);
  }
}

function checkChangelog(changelog, filePath, expectedVersion) {
  if (!new RegExp(`^##\\s+${expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m").test(changelog)) {
    fail(`${filePath} must contain a ## ${expectedVersion} entry before release.`);
  }
}

const rootPackage = await readJson("package.json");
const vscodePackage = await readJson("vscode-extension/package.json");
const pluginPackage = await readJson("plugin.json");
const rootLock = await readJson("package-lock.json");
const vscodeLock = await readJson("vscode-extension/package-lock.json");
const rootChangelog = await readText("CHANGELOG.md");
const vscodeChangelog = await readText("vscode-extension/CHANGELOG.md");
const rootInstallStatus = await readText("lib/install-status.cjs");
const vscodeInstallStatus = await readText("vscode-extension/lib/install-status.cjs");
const rootJsoncFile = await readText("lib/jsonc-file.cjs");
const vscodeJsoncFile = await readText("vscode-extension/lib/jsonc-file.cjs");
const rootCopilotPaths = await readText("lib/copilot-paths.cjs");
const vscodeCopilotPaths = await readText("vscode-extension/lib/copilot-paths.cjs");
const rootRuntimeBundle = await readText("lib/runtime-bundle.cjs");
const vscodeRuntimeBundle = await readText("vscode-extension/lib/runtime-bundle.cjs");

if (rootPackage.version !== vscodePackage.version) {
  fail(`Version mismatch: package.json is ${rootPackage.version}, vscode-extension/package.json is ${vscodePackage.version}.`);
}

if (rootPackage.version !== pluginPackage.version) {
  fail(`Version mismatch: package.json is ${rootPackage.version}, plugin.json is ${pluginPackage.version}.`);
}

if (rootPackage.name !== vscodePackage.name) {
  fail(`Package name mismatch: package.json is ${rootPackage.name}, vscode-extension/package.json is ${vscodePackage.name}.`);
}

if (rootPackage.repository?.url && vscodePackage.repository?.url) {
  const rootUrl = rootPackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const vscodeUrl = vscodePackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  if (rootUrl !== vscodeUrl) {
    fail(`Repository mismatch: package.json is ${rootPackage.repository.url}, vscode-extension/package.json is ${vscodePackage.repository.url}.`);
  }
}

if (!vscodePackage.author?.name) {
  fail("vscode-extension/package.json must include author.name.");
}

checkLockVersion(rootLock, "package-lock.json", rootPackage.version);
checkLockVersion(vscodeLock, "vscode-extension/package-lock.json", vscodePackage.version);
checkChangelog(rootChangelog, "CHANGELOG.md", rootPackage.version);
checkChangelog(vscodeChangelog, "vscode-extension/CHANGELOG.md", vscodePackage.version);

if (rootInstallStatus !== vscodeInstallStatus) {
  fail("lib/install-status.cjs and vscode-extension/lib/install-status.cjs must stay identical.");
}

if (rootJsoncFile !== vscodeJsoncFile) {
  fail("lib/jsonc-file.cjs and vscode-extension/lib/jsonc-file.cjs must stay identical.");
}

if (rootCopilotPaths !== vscodeCopilotPaths) {
  fail("lib/copilot-paths.cjs and vscode-extension/lib/copilot-paths.cjs must stay identical.");
}

if (rootRuntimeBundle !== vscodeRuntimeBundle) {
  fail("lib/runtime-bundle.cjs and vscode-extension/lib/runtime-bundle.cjs must stay identical.");
}
