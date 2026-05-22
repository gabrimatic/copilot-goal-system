#!/usr/bin/env node
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(extensionRoot, "..");
const targetRoot = path.join(extensionRoot, "resources", "goal-system");
const require = createRequire(import.meta.url);
const { isBundledRuntimePath, runtimeEntries } = require("../lib/runtime-bundle.cjs");

function filter(source) {
  return isBundledRuntimePath(source, projectRoot);
}

async function copyEntry(entry) {
  const source = path.join(projectRoot, entry);
  const target = path.join(targetRoot, entry);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: true,
    filter,
  });
}

async function main() {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });

  for (const entry of runtimeEntries) {
    await copyEntry(entry);
  }

  await chmod(path.join(targetRoot, "install.sh"), fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
  await chmod(path.join(targetRoot, "scripts", "install.sh"), fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
  await chmod(path.join(targetRoot, "hooks", "goal-context.sh"), fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
