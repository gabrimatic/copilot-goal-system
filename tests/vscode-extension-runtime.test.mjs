import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const {
  runtimeUpdatePromptKey,
  runtimeVersionState,
} = require("../vscode-extension/lib/runtime-version.cjs");
const {
  countDuplicateGoalHooks,
  findStaleDriftHookEvents,
  hasLegacyCliGoalServer,
  hasLegacyVscodeGoalServer,
  hookInstalled,
  isGoalContextHook,
} = require("../vscode-extension/lib/install-status.cjs");
const vscodePackageJson = require("../vscode-extension/package.json");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") return { workspace: { getConfiguration: () => ({ get: () => undefined }) }, window: {}, commands: {}, env: {}, Uri: {}, StatusBarAlignment: { Left: 1 } };
  return originalLoad.call(this, request, parent, isMain);
};
const { surfaceSummary } = require("../vscode-extension/extension.cjs");
Module._load = originalLoad;

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

test("install status recognizes direct and composite goal hook commands", () => {
  assert.equal(isGoalContextHook({ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh" }), true);
  assert.equal(isGoalContextHook({ type: "command", bash: "$COPILOT_HOME/hooks/goal-context.sh" }), true);
  assert.equal(isGoalContextHook({ type: "command", bash: "/tmp/custom-copilot/hooks/goal-context.sh" }), true);
  assert.equal(isGoalContextHook({ type: "command", bash: "~/.copilot/hooks/goal-context.sh" }), true);
  assert.equal(
    isGoalContextHook({
      type: "command",
      bash: "~/.copilot/hooks/merge-hook-context.sh ~/.copilot/hooks/system-info.sh ~/.copilot/hooks/goal-context.sh",
    }),
    true
  );
  assert.equal(isGoalContextHook({ type: "command", bash: "~/.copilot/hooks/not-goal-context.sh" }), false);
});

test("install status reports duplicate goal hooks and stale drift hooks", () => {
  const settings = {
    hooks: {
      sessionStart: [
        {
          type: "command",
          bash: "~/.copilot/hooks/merge-hook-context.sh ~/.copilot/hooks/system-info.sh ~/.copilot/hooks/goal-context.sh",
        },
        {
          type: "command",
          bash: "$HOME/.copilot/hooks/goal-context.sh",
        },
      ],
      agentStop: [
        {
          type: "command",
          bash: "~/.copilot/hooks/goal-context.sh",
        },
        {
          type: "command",
          bash: "$HOME/.copilot/hooks/goal-context.sh",
        },
      ],
      preToolUse: [
        {
          type: "command",
          bash: "$HOME/.copilot/hooks/goal-context.sh",
        },
      ],
    },
  };

  assert.equal(hookInstalled(settings, "sessionStart"), true);
  assert.deepEqual(countDuplicateGoalHooks(settings, ["sessionStart", "agentStop"]), {
    sessionStart: 1,
    agentStop: 1,
  });
  assert.deepEqual(findStaleDriftHookEvents(settings), ["preToolUse"]);
});

test("install status detects legacy goalSystem server entries for cleanup", () => {
  assert.equal(
    hasLegacyCliGoalServer({
      mcpServers: {
        goalSystem: {
          type: "stdio",
          command: "node",
          args: ["/tmp/old/mcp-server.mjs"],
        },
      },
    }),
    true
  );
  assert.equal(hasLegacyCliGoalServer({ mcpServers: { playwright: { command: "npx" } } }), false);
  assert.equal(hasLegacyVscodeGoalServer({ servers: { goalSystem: { command: "node" } } }), true);
  assert.equal(hasLegacyVscodeGoalServer({ servers: { existingServer: { command: "node" } } }), false);
});

test("VS Code language model tools expose issue resolution input", () => {
  const tools = new Map(vscodePackageJson.contributes.languageModelTools.map((tool) => [tool.name, tool]));
  for (const toolName of ["goal_system_update", "goal_system_close"]) {
    const issueResolutions = tools.get(toolName)?.inputSchema?.properties?.issueResolutions;
    assert.equal(issueResolutions?.type, "array");
    assert.equal(issueResolutions.items?.properties?.status?.enum.includes("renamed"), true);
    assert.equal(issueResolutions.items?.properties?.evidence?.items?.type, "string");
  }
});

test("surface status cannot report adapters ready when runtime is missing", () => {
  const status = {
    runtimeState: { status: "missing", installed: false },
    checks: [
      ["Extension package", false],
      ["Local runtime version", false],
      ["Production dependencies", false],
      ["Local goalctl command", false],
      ["Goal skill", true],
      ["CLI hook helper", true],
      ["CLI settings JSON", true],
      ["CLI hooks enabled", true],
      ["All CLI hook entries", true],
      ["No duplicate CLI goal hooks", true],
      ["No stale CLI drift hooks", true],
      ["No legacy CLI goalSystem server", true],
      ["Instruction snippet", true],
      ["VS Code Chat custom agent", true],
      ["VS Code Chat hook config", true],
      ["No legacy VS Code goalSystem server", true],
    ],
  };

  assert.deepEqual(surfaceSummary(status), {
    runtime: "Missing",
    cli: "Needs attention",
    vscodeChat: "Needs attention",
    recommended: false,
  });
});
