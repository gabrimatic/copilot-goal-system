import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  runtimeUpdatePromptKey,
  runtimeVersionState,
} = require("../vscode-extension/lib/runtime-version.cjs");

test("runtimeVersionState requires install when runtime package is missing", () => {
  assert.deepEqual(
    runtimeVersionState({
      bundledVersion: "1.1.1",
      installedPackagePresent: false,
      installedVersion: "",
    }),
    {
      installed: false,
      needsUpdate: true,
      status: "missing",
    },
  );
});

test("runtimeVersionState requires update when installed runtime is older than extension bundle", () => {
  assert.deepEqual(
    runtimeVersionState({
      bundledVersion: "1.1.1",
      installedPackagePresent: true,
      installedVersion: "1.1.0",
    }),
    {
      installed: true,
      needsUpdate: true,
      status: "stale",
    },
  );
});

test("runtimeVersionState accepts matching installed and bundled versions", () => {
  assert.deepEqual(
    runtimeVersionState({
      bundledVersion: "1.1.1",
      installedPackagePresent: true,
      installedVersion: "1.1.1",
    }),
    {
      installed: true,
      needsUpdate: false,
      status: "current",
    },
  );
});

test("runtimeUpdatePromptKey is stable and scoped to home plus bundled version", () => {
  const first = runtimeUpdatePromptKey("/tmp/copilot-a", "1.1.1");
  const again = runtimeUpdatePromptKey("/tmp/copilot-a", "1.1.1");
  const otherHome = runtimeUpdatePromptKey("/tmp/copilot-b", "1.1.1");
  const otherVersion = runtimeUpdatePromptKey("/tmp/copilot-a", "1.1.2");

  assert.equal(first, again);
  assert.notEqual(first, otherHome);
  assert.notEqual(first, otherVersion);
  assert.match(first, /^runtimeUpdatePrompt\.lastOffered\.[a-f0-9]{40}$/);
});
