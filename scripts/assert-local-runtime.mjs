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
const mcpServerFile = path.join("adapters", "mcp", "server.mjs");
const requiredSdkPackage = "@modelcontextprotocol/sdk";

if (!(await exists(mcpServerFile))) {
  fail(`${mcpServerFile} must exist; MCP support uses a local stdio server plus goalctl fallback.`);
}

const rootDependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
if (!rootDependencies[requiredSdkPackage]) {
  fail(`package.json must depend on ${requiredSdkPackage}.`);
}

if (!packageLock.packages?.[`node_modules/${requiredSdkPackage}`]) {
  fail(`package-lock.json must include ${requiredSdkPackage}.`);
}

if (!checkScript.includes("adapters/mcp/server.mjs")) {
  fail("npm run check must syntax-check adapters/mcp/server.mjs.");
}
