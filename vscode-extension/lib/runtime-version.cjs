"use strict";

const { createHash } = require("node:crypto");

function normalizeVersion(value) {
  const version = String(value || "").trim();
  return version || "";
}

function runtimeVersionState({ bundledVersion, installedPackagePresent, installedVersion }) {
  const bundled = normalizeVersion(bundledVersion);
  const installed = normalizeVersion(installedVersion);

  if (!installedPackagePresent) {
    return {
      installed: false,
      needsUpdate: true,
      status: "missing",
    };
  }

  if (!installed || installed !== bundled) {
    return {
      installed: true,
      needsUpdate: true,
      status: "stale",
    };
  }

  return {
    installed: true,
    needsUpdate: false,
    status: "current",
  };
}

function runtimeUpdatePromptKey(home, bundledVersion) {
  const digest = createHash("sha1")
    .update(`${normalizeVersion(home)}\n${normalizeVersion(bundledVersion)}`)
    .digest("hex");
  return `runtimeUpdatePrompt.lastOffered.${digest}`;
}

module.exports = {
  runtimeUpdatePromptKey,
  runtimeVersionState,
};
