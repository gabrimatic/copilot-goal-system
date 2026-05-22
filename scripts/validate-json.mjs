#!/usr/bin/env node
import { readFile } from "node:fs/promises";

let failed = false;

for (const filePath of process.argv.slice(2)) {
  try {
    JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    failed = true;
    console.error(`${filePath}: ${error.message}`);
  }
}

if (failed) process.exit(1);
