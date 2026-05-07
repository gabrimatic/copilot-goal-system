#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8"));
const outputPath = path.join(extensionRoot, "..", "dist", `${packageJson.name}-${packageJson.version}.vsix`);

mkdirSync(path.dirname(outputPath), { recursive: true });

const result = spawnSync("vsce", ["package", "--out", outputPath], {
  cwd: extensionRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
