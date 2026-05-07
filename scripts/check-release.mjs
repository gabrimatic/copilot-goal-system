#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const rootPackage = await readJson("package.json");
const vscodePackage = await readJson("vscode-extension/package.json");

if (rootPackage.version !== vscodePackage.version) {
  fail(`Version mismatch: package.json is ${rootPackage.version}, vscode-extension/package.json is ${vscodePackage.version}.`);
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
