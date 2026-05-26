"use strict";

const path = require("node:path");

const runtimeEntries = [
  ".github/hooks/goal-system.json",
  "adapters",
  "bin",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "doc",
  "extension.mjs",
  "hooks.json",
  "hooks",
  "install.sh",
  "instructions",
  "lib",
  "node_modules/jsonc-parser",
  "package-lock.json",
  "package.json",
  "plugin.json",
  "scripts",
  "skills",
  "tests",
];

function isBundledRuntimePath(source, projectRoot) {
  const relative = path.relative(projectRoot, source);
  if (!relative) return true;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return runtimeEntries.some((entry) => relative === entry || relative.startsWith(entry + path.sep));
}

module.exports = {
  isBundledRuntimePath,
  runtimeEntries,
};
