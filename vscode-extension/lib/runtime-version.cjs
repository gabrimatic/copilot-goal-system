"use strict";

const { createHash } = require("node:crypto");

function normalizeVersion(value) {
  const version = String(value || "").trim();
  return version || "";
}

// Returns -1, 0, or 1 for a numeric major.minor.patch(...) comparison, or null when
// either version has a non-numeric segment and cannot be compared numerically.
function compareVersions(a, b) {
  const partsA = a.split(".");
  const partsB = b.split(".");
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const numA = Number(partsA[i] ?? 0);
    const numB = Number(partsB[i] ?? 0);
    if (!Number.isFinite(numA) || !Number.isFinite(numB)) return null;
    if (numA !== numB) return numA < numB ? -1 : 1;
  }
  return 0;
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

  if (!installed) {
    return {
      installed: true,
      needsUpdate: true,
      status: "stale",
    };
  }

  const comparison = bundled ? compareVersions(installed, bundled) : null;

  // Unparseable versions fall back to the previous strict-equality behavior.
  if (comparison === null) {
    return installed === bundled
      ? { installed: true, needsUpdate: false, status: "current" }
      : { installed: true, needsUpdate: true, status: "stale" };
  }

  if (comparison < 0) {
    return { installed: true, needsUpdate: true, status: "stale" };
  }
  if (comparison > 0) {
    return { installed: true, needsUpdate: false, status: "newer" };
  }
  return { installed: true, needsUpdate: false, status: "current" };
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
