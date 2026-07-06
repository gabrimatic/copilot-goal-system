"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vscode = require("vscode");
const EXTENSION_PACKAGE = require("./package.json");
const {
  runtimeUpdatePromptKey,
  runtimeVersionState,
} = require("./lib/runtime-version.cjs");
const { copilotRootForHome } = require("./lib/copilot-paths.cjs");
const {
  countDuplicateGoalHooks,
  findStaleDriftHookEvents,
  hookInstalled,
} = require("./lib/install-status.cjs");
const { parseJsoncText } = require("./lib/jsonc-file.cjs");

const DISPLAY_NAME = "Copilot Goal System";
const DOCS_URL = "https://github.com/gabrimatic/copilot-goal-system#readme";
const FIRST_INSTALL_PROMPT_KEY = "firstInstallPrompt.dismissed.v2";
const CLI_HOOK_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "preCompact",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "notification",
];
const VSCODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];
const RUNTIME_CHECK_LABELS = ["Extension package", "Local runtime version", "Production dependencies", "Local goalctl command", "MCP server file"];
const CLI_CHECK_LABELS = [
  "Goal skill",
  "CLI hook helper",
  "CLI settings JSON",
  "CLI hooks enabled",
  "All CLI hook entries",
  "No duplicate CLI goal hooks",
  "No stale wrapped drift hooks",
  "Instruction snippet",
];
const VSCODE_CHAT_CHECK_LABELS = ["VS Code Chat custom agent", "VS Code Chat hook config"];
const MCP_CHECK_LABELS = ["MCP config JSON", "MCP server config"];

let installInProgress = false;

function activate(context) {
  const output = vscode.window.createOutputChannel(DISPLAY_NAME);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.name = DISPLAY_NAME;
  context.subscriptions.push(output);
  context.subscriptions.push(statusBar);
  registerGoalTools(context, output);

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotGoalSystem.install", () => installGoalSystem(context, output, statusBar, "all")),
    vscode.commands.registerCommand("copilotGoalSystem.installCli", () => installGoalSystem(context, output, statusBar, "cli")),
    vscode.commands.registerCommand("copilotGoalSystem.installMcp", () => installGoalSystem(context, output, statusBar, "mcp")),
    vscode.commands.registerCommand("copilotGoalSystem.installVscodeChat", () => installGoalSystem(context, output, statusBar, "vscode-chat")),
    vscode.commands.registerCommand("copilotGoalSystem.status", () => showInstallStatus(output, statusBar)),
    vscode.commands.registerCommand("copilotGoalSystem.openWalkthrough", openWalkthrough),
    vscode.commands.registerCommand("copilotGoalSystem.copyPrompt", () => copyRuntimePrompt(context)),
    vscode.commands.registerCommand("copilotGoalSystem.openDocs", openDocs),
    vscode.commands.registerCommand("copilotGoalSystem.openInstalledFiles", () => revealPath(installedPaths().extensionDir, "Installed files")),
    vscode.commands.registerCommand("copilotGoalSystem.openStateFolder", () => revealPath(installedPaths().stateRoot, "Goal state folder")),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("copilotGoalSystem.showStatusBar") ||
        event.affectsConfiguration("copilotGoalSystem.homeOverride")
      ) {
        updateStatusBar(statusBar, output);
      }
    })
  );

  updateStatusBar(statusBar, output);
  setTimeout(() => {
    runActivationPrompts(context, output, statusBar).catch((error) => {
      output.appendLine(`Activation setup check failed: ${error.message || String(error)}`);
    });
  }, 1500);
}

function deactivate() {}

function config() {
  return vscode.workspace.getConfiguration("copilotGoalSystem");
}

function resolveOverrideHome(override, homedir) {
  if (override === "~") return homedir;
  if (override.startsWith("~/")) return path.join(homedir, override.slice(2));
  return path.resolve(override);
}

// homeOverride, when set, must win over an ambient COPILOT_HOME the extension host
// inherited from the shell: that env var otherwise takes absolute precedence in
// copilotRootForHome, silently ignoring the user's setting.
function resolveCopilotRoot(overrideValue, env = process.env, homedir = os.homedir()) {
  const override = String(overrideValue || "").trim();
  if (!override) {
    const home = homedir;
    return { home, copilotRoot: copilotRootForHome(home, env), overridden: false };
  }
  const home = resolveOverrideHome(override, homedir);
  return { home, copilotRoot: path.join(home, ".copilot"), overridden: true };
}

function configuredHome() {
  return resolveCopilotRoot(config().get("homeOverride", "")).home;
}

function installedPaths() {
  const { home, copilotRoot } = resolveCopilotRoot(config().get("homeOverride", ""));
  return {
    home,
    copilotRoot,
    extensionDir: path.join(copilotRoot, "extensions", "goal-system"),
    goalctlFile: path.join(copilotRoot, "extensions", "goal-system", "bin", "goalctl.mjs"),
    mcpServerFile: path.join(copilotRoot, "extensions", "goal-system", "adapters", "mcp", "server.mjs"),
    skillFile: path.join(copilotRoot, "skills", "goal", "SKILL.md"),
    hookFile: path.join(copilotRoot, "hooks", "goal-context.sh"),
    vscodeHookConfigFile: path.join(copilotRoot, "hooks", "goal-system-vscode.json"),
    vscodeAgentFile: path.join(copilotRoot, "agents", "goal-system.agent.md"),
    settingsFile: path.join(copilotRoot, "settings.json"),
    mcpConfigFile: path.join(copilotRoot, "mcp-config.json"),
    instructionsFile: path.join(copilotRoot, "copilot-instructions.md"),
    sdkPackage: path.join(copilotRoot, "extensions", "goal-system", "node_modules", "@github", "copilot-sdk", "package.json"),
    mcpSdkPackage: path.join(copilotRoot, "extensions", "goal-system", "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
    zodPackage: path.join(copilotRoot, "extensions", "goal-system", "node_modules", "zod", "package.json"),
    stateRoot: path.join(copilotRoot, "session-state", "goal-system"),
  };
}

function bundleRoot(context) {
  return path.join(context.extensionPath, "resources", "goal-system");
}

function installerPath(context) {
  return path.join(bundleRoot(context), "scripts", "install.mjs");
}

async function loadGoalCore(context) {
  const bundleCorePath = path.join(bundleRoot(context), "lib", "goal-core.mjs");
  return import(pathToFileURL(bundleCorePath).href);
}

function toolTextResult(text) {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function toolContext(input) {
  const sessionId = String(input.sessionId || "").trim();
  const cwd = String(input.cwd || "").trim();
  if (!sessionId) throw new Error("sessionId is required. Use the Session ID from the Goal System hook context.");
  if (!cwd) throw new Error("cwd is required. Use the CWD from the Goal System hook context.");
  return { sessionId, cwd };
}

function patchFromToolInput(input) {
  const patch = { ...input };
  delete patch.sessionId;
  delete patch.cwd;
  return patch;
}

class GoalSystemLanguageTool {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
  }

  async prepareInvocation(options) {
    const action = {
      status: "Read persisted goal state",
      open: "Open persisted goal",
      checkpoint: "Checkpoint persisted goal",
      update: "Update persisted goal",
      finish: "Finish persisted goal",
      close: "Close persisted goal",
    }[this.kind];
    const sessionId = String(options.input?.sessionId || "missing");
    if (this.kind === "status") {
      return { invocationMessage: action };
    }
    return {
      invocationMessage: action,
      confirmationMessages: {
        title: action,
        message: new vscode.MarkdownString(`Run ${action.toLowerCase()} for session \`${sessionId}\`.`),
      },
    };
  }

  async invoke(options) {
    const input = options.input || {};
    const core = await loadGoalCore(this.context);
    const paths = installedPaths();
    const store = new core.GoalStore({
      stateRoot: path.join(paths.copilotRoot, "session-state", "goal-system"),
      workspaceStateRoot: path.join(paths.copilotRoot, "session-state"),
    });
    await store.init();

    const { sessionId, cwd } = toolContext(input);
    const record = await store.loadGoalRecord(sessionId, cwd);

    if (this.kind === "status") {
      if (!record || !core.isOpenGoal(record.goal)) {
        return toolTextResult("No persisted active goal is stored for this VS Code session/workspace.");
      }
      return toolTextResult(core.formatGoalSummary(record.goal, { includeHistory: true }));
    }

    if (this.kind === "open") {
      if (record && core.isOpenGoal(record.goal) && input.replaceExisting !== true) {
        throw new Error(
          "An active persisted goal already exists for this VS Code session/workspace. Use goal_system_checkpoint, or pass replaceExisting only when the prompt clearly replaces the current goal."
        );
      }
      const patch = patchFromToolInput(input);
      const goal = core.createGoalRecord(patch, sessionId, cwd, {
        sourcePrompt: patch.sourcePrompt,
        historyNote: patch.historyNote || "VS Code goal opened or replaced",
      });
      const persisted = await store.persistGoalRecord(sessionId, cwd, goal);
      store.auditLog("vscode_tool_open", { sid: sessionId, id: persisted.id, replaced: Boolean(record && core.isOpenGoal(record.goal)) });
      return toolTextResult(core.formatGoalSummary(persisted));
    }

    if (!record || !record.goal) {
      throw new Error("No persisted goal exists yet. Use goal_system_open first with the current sessionId and cwd.");
    }
    if (!core.isOpenGoal(record.goal)) {
      throw new Error("The persisted goal is already closed. Open a new goal only when the prompt explicitly asks for one.");
    }

    if (this.kind === "checkpoint") {
      if (typeof input.completionStatus === "string" && !core.MUTABLE_GOAL_STATUSES.includes(input.completionStatus)) {
        throw new Error("goal_system_checkpoint cannot mark a goal complete or cancelled. Use goal_system_finish after verification.");
      }
      const patch = patchFromToolInput(input);
      const changedFields = Object.keys(patch).filter((key) => !["historyNote", "sourcePrompt"].includes(key) && patch[key] !== undefined);
      if (!changedFields.length) {
        throw new Error("goal_system_checkpoint requires at least one real state field such as inspectionEvidence, verificationResults, doneSoFar, remaining, or blockers.");
      }
      const checkpointPatch = { ...patch };
      if (record.goal.completionStatus === "draft" && checkpointPatch.completionStatus === undefined) {
        checkpointPatch.completionStatus = "active";
      }
      const nextGoal = core.mergeGoal(record.goal, checkpointPatch, "update", checkpointPatch.historyNote || "VS Code goal checkpoint saved");
      const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
      store.auditLog("vscode_tool_checkpoint", { sid: sessionId, id: persisted.id, fields: changedFields });
      return toolTextResult(`Checkpoint saved.\n${core.formatGoalSummary(persisted)}`);
    }

    if (this.kind === "update") {
      if (typeof input.completionStatus === "string" && !core.MUTABLE_GOAL_STATUSES.includes(input.completionStatus)) {
        throw new Error("goal_system_update cannot mark a goal complete or cancelled. Use goal_system_finish after verification.");
      }
      const patch = patchFromToolInput(input);
      const changedFields = Object.keys(patch).filter((key) => !["historyNote", "sourcePrompt"].includes(key) && patch[key] !== undefined);
      if (!changedFields.length) {
        throw new Error("goal_system_update requires at least one real state field such as inspectionEvidence, verificationResults, doneSoFar, remaining, or blockers. For normal progress, use goal_system_checkpoint.");
      }
      const nextGoal = core.mergeGoal(record.goal, patch, "update", patch.historyNote || "VS Code goal state updated");
      const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
      store.auditLog("vscode_tool_update", { sid: sessionId, id: persisted.id, fields: changedFields });
      return toolTextResult(core.formatGoalSummary(persisted));
    }

    if (this.kind === "finish") {
      const patch = {
        ...patchFromToolInput(input),
        completionStatus: "complete",
        blockers: Array.isArray(input.blockers) ? input.blockers : [],
        remaining: Array.isArray(input.remaining) ? input.remaining : [],
      };
      const nextGoal = core.mergeGoal(record.goal, patch, "close", patch.summary || "VS Code goal finished");
      nextGoal.closedAt = new Date().toISOString();
      const failures = core.validateGoalCompletion(nextGoal);
      if (failures.length) {
        throw new Error(`Refusing to finish the goal. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`);
      }
      const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
      store.auditLog("vscode_tool_finish", { sid: sessionId, id: persisted.id });
      return toolTextResult(`Goal finished.\n${core.formatGoalSummary(persisted, { includeHistory: false })}`);
    }

    if (this.kind === "close") {
      const patch = patchFromToolInput(input);
      if (!["complete", "blocked", "cancelled"].includes(patch.completionStatus)) {
        throw new Error("goal_system_close requires completionStatus complete, blocked, or cancelled.");
      }
      const nextGoal = core.mergeGoal(
        record.goal,
        {
          ...patch,
          blockers: patch.completionStatus === "complete" && !Array.isArray(patch.blockers) ? [] : patch.blockers,
          remaining: patch.completionStatus === "complete" && !Array.isArray(patch.remaining) ? [] : patch.remaining,
        },
        "close",
        patch.summary || `VS Code goal marked ${patch.completionStatus}`
      );
      nextGoal.closedAt = new Date().toISOString();
      if (patch.completionStatus === "complete") {
        const failures = core.validateGoalCompletion(nextGoal);
        if (failures.length) {
          throw new Error(`Refusing to mark the goal complete. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`);
        }
      }
      const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
      store.auditLog("vscode_tool_close", { sid: sessionId, id: persisted.id, status: patch.completionStatus });
      return toolTextResult(core.formatGoalSummary(persisted, { includeHistory: false }));
    }

    throw new Error(`Unsupported goal tool kind: ${this.kind}`);
  }
}

function registerGoalTools(context, output) {
  if (!vscode.lm || typeof vscode.lm.registerTool !== "function") {
    output.appendLine("VS Code language model tool API is unavailable; Goal System will use hooks and local goalctl fallback only.");
    return;
  }
  for (const [name, kind] of [
    ["goal_system_status", "status"],
    ["goal_system_open", "open"],
    ["goal_system_checkpoint", "checkpoint"],
    ["goal_system_update", "update"],
    ["goal_system_finish", "finish"],
    ["goal_system_close", "close"],
  ]) {
    context.subscriptions.push(vscode.lm.registerTool(name, new GoalSystemLanguageTool(context, kind)));
  }
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return parseJsoncText(raw, filePath);
}

async function readPackageVersion(filePath) {
  const packageJson = await readJson(filePath);
  return String(packageJson.version || "").trim();
}

function vscodeHookConfigInstalled(config) {
  if (!config || typeof config !== "object" || !config.hooks || typeof config.hooks !== "object") return false;
  return VSCODE_HOOK_EVENTS.every((eventName) => {
    const hooks = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
    return hooks.some((hook) => hook && hook.type === "command" && /hook-runner\.mjs/.test(String(hook.command || hook.windows || "")));
  });
}

function statusIsInstalled(status) {
  return status.checks.every(([, ok]) => ok);
}

function missingChecks(status) {
  return status.checks.filter(([, ok]) => !ok).map(([label]) => label);
}

function checkOk(status, label) {
  const match = status.checks.find(([checkLabel]) => checkLabel === label);
  return Boolean(match && match[1]);
}

function allChecksOk(status, labels) {
  return labels.every((label) => checkOk(status, label));
}

function anyCheckOk(status, labels) {
  return labels.some((label) => checkOk(status, label));
}

function surfaceSummary(status) {
  const runtimeReady = allChecksOk(status, RUNTIME_CHECK_LABELS);
  const cliReady = runtimeReady && allChecksOk(status, CLI_CHECK_LABELS);
  const vscodeReady = runtimeReady && allChecksOk(status, VSCODE_CHAT_CHECK_LABELS);
  const mcpReady = runtimeReady && allChecksOk(status, MCP_CHECK_LABELS);
  const cliEvidence = anyCheckOk(status, ["Goal skill", "CLI hook helper", "All CLI hook entries", "Local goalctl command", "Instruction snippet"]);
  const vscodeEvidence = anyCheckOk(status, VSCODE_CHAT_CHECK_LABELS);
  const mcpEvidence = anyCheckOk(status, ["MCP server file", ...MCP_CHECK_LABELS]);
  return {
    runtime: runtimeReady ? "Current" : status.runtimeState.status === "stale" ? "Update needed" : status.runtimeState.installed ? "Needs attention" : "Missing",
    cli: cliReady ? "Ready" : cliEvidence ? "Needs attention" : "Not installed",
    vscodeChat: vscodeReady ? "Ready" : vscodeEvidence ? "Needs attention" : "Not installed",
    mcp: mcpReady ? "Ready" : mcpEvidence ? "Needs attention" : "Not installed",
    recommended: runtimeReady && cliReady && vscodeReady && mcpReady,
  };
}

async function collectStatus() {
  const paths = installedPaths();
  const bundledVersion = String(EXTENSION_PACKAGE.version || "0.0.0").trim();
  const installedPackagePath = path.join(paths.extensionDir, "package.json");
  const installedPackagePresent = await exists(installedPackagePath);
  let installedVersion = "";
  let installedPackageError = "";
  let settings = null;
  let settingsError = "";
  let mcpConfig = null;
  let mcpConfigError = "";
  let vscodeHookConfig = null;
  let vscodeHookConfigError = "";

  if (installedPackagePresent) {
    try {
      installedVersion = await readPackageVersion(installedPackagePath);
    } catch (error) {
      installedPackageError = error && error.message ? error.message : "installed package.json could not be parsed";
    }
  }

  const runtimeState = runtimeVersionState({
    bundledVersion,
    installedPackagePresent,
    installedVersion,
  });

  if (await exists(paths.settingsFile)) {
    try {
      settings = await readJson(paths.settingsFile);
    } catch (error) {
      settingsError = error && error.message ? error.message : "settings.json could not be parsed";
    }
  }

  if (await exists(paths.mcpConfigFile)) {
    try {
      mcpConfig = await readJson(paths.mcpConfigFile);
    } catch (error) {
      mcpConfigError = error && error.message ? error.message : "mcp-config.json could not be parsed";
    }
  }

  if (await exists(paths.vscodeHookConfigFile)) {
    try {
      vscodeHookConfig = await readJson(paths.vscodeHookConfigFile);
    } catch (error) {
      vscodeHookConfigError = error && error.message ? error.message : "VS Code hook config could not be parsed";
    }
  }

  const cliHookEventsPresent = settings ? CLI_HOOK_EVENTS.filter((eventName) => hookInstalled(settings, eventName)) : [];
  const duplicateCliGoalHooks = settings ? countDuplicateGoalHooks(settings, CLI_HOOK_EVENTS) : {};
  const staleCliDriftHookEvents = settings ? findStaleDriftHookEvents(settings) : [];
  const cliHooksDisabled = Boolean(settings && settings.disableAllHooks);
  const configuredMcpServer = mcpConfig && mcpConfig.mcpServers && mcpConfig.mcpServers.goalSystem;
  const mcpServerConfigured = Boolean(
    configuredMcpServer &&
      (configuredMcpServer.type === "local" || configuredMcpServer.type === "stdio") &&
      configuredMcpServer.command === "node" &&
      Array.isArray(configuredMcpServer.args) &&
      configuredMcpServer.args[0] === paths.mcpServerFile &&
      Array.isArray(configuredMcpServer.tools) &&
      configuredMcpServer.tools.includes("*")
  );

  return {
    paths,
    bundledVersion,
    installedVersion,
    runtimeState,
    checks: [
      ["Extension package", installedPackagePresent && !installedPackageError],
      ["Local runtime version", !runtimeState.needsUpdate && !installedPackageError],
      ["Production dependencies", await exists(paths.sdkPackage) && await exists(paths.mcpSdkPackage) && await exists(paths.zodPackage)],
      ["Local goalctl command", await exists(paths.goalctlFile)],
      ["MCP server file", await exists(paths.mcpServerFile)],
      ["Goal skill", await exists(paths.skillFile)],
      ["CLI hook helper", await exists(paths.hookFile)],
      ["CLI settings JSON", Boolean(settings) && !settingsError],
      ["CLI hooks enabled", Boolean(settings) && !cliHooksDisabled],
      ["All CLI hook entries", cliHookEventsPresent.length === CLI_HOOK_EVENTS.length],
      ["No duplicate CLI goal hooks", Object.keys(duplicateCliGoalHooks).length === 0],
      ["No stale wrapped drift hooks", staleCliDriftHookEvents.length === 0],
      ["Instruction snippet", await instructionsSnippetInstalled(paths.instructionsFile)],
      ["VS Code Chat custom agent", await exists(paths.vscodeAgentFile)],
      ["VS Code Chat hook config", vscodeHookConfigInstalled(vscodeHookConfig)],
      ["MCP config JSON", Boolean(mcpConfig) && !mcpConfigError],
      ["MCP server config", mcpServerConfigured],
    ],
    cliHookEventsPresent,
    duplicateCliGoalHooks,
    staleCliDriftHookEvents,
    cliHooksDisabled,
    vscodeHookConfigInstalled: vscodeHookConfigInstalled(vscodeHookConfig),
    installedPackageError,
    settingsError,
    mcpConfigError,
    vscodeHookConfigError,
  };
}

async function instructionsSnippetInstalled(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw.includes("<!-- copilot-goal-system snippet start -->");
  } catch {
    return false;
  }
}

function formatStatusReport(status) {
  const installed = statusIsInstalled(status);
  const missing = missingChecks(status);
  const summary = surfaceSummary(status);
  const result = installed ? "Recommended setup ready" : summary.cli === "Ready" || summary.vscodeChat === "Ready" ? "Partially ready" : "Needs attention";
  const lines = [
    `${DISPLAY_NAME} install status`,
    "",
    `Home: ${status.paths.home}`,
    `Installed package: ${status.paths.extensionDir}`,
    `Extension version: ${status.bundledVersion}`,
    `Installed runtime version: ${status.installedVersion || (status.runtimeState.installed ? "unknown" : "missing")}`,
    `Runtime files: ${status.runtimeState.needsUpdate ? "Update needed" : "Current"}`,
    `CLI: ${summary.cli}`,
    `VS Code Chat: ${summary.vscodeChat}`,
    `MCP: ${summary.mcp}`,
    `Runtime: ${summary.runtime}`,
    `Result: ${result}`,
    `Goalctl: ${checkOk(status, "Local goalctl command") ? "Installed" : "Needs attention"}`,
    `MCP server: ${checkOk(status, "MCP server config") ? "Configured" : "Needs attention"}`,
    "",
    "Checks:",
    ...status.checks.map(([label, ok]) => `[${ok ? "OK" : "Issue"}] ${label}`),
    "",
    `CLI hook entries: ${status.cliHookEventsPresent.length}/${CLI_HOOK_EVENTS.length}`,
    `CLI hooks disabled: ${status.cliHooksDisabled ? "Yes" : "No"}`,
    `VS Code hook config: ${status.vscodeHookConfigInstalled ? "Installed" : "Needs attention"}`,
  ];

  const duplicateEvents = Object.entries(status.duplicateCliGoalHooks || {});
  if (duplicateEvents.length > 0) {
    lines.push("", "Duplicate CLI goal hooks:", ...duplicateEvents.map(([eventName, extraCount]) => `- ${eventName}: ${extraCount} extra goal hook${extraCount === 1 ? "" : "s"}`));
  }

  if (status.staleCliDriftHookEvents && status.staleCliDriftHookEvents.length > 0) {
    lines.push("", "Stale CLI drift hooks:", ...status.staleCliDriftHookEvents.map((eventName) => `- ${eventName}`));
  }

  if (status.settingsError) {
    lines.push("", `Settings error: ${status.settingsError}`);
  }
  if (status.mcpConfigError) {
    lines.push("", `MCP config error: ${status.mcpConfigError}`);
  }
  if (status.installedPackageError) {
    lines.push("", `Installed package error: ${status.installedPackageError}`);
  }
  if (status.vscodeHookConfigError) {
    lines.push("", `VS Code hook config error: ${status.vscodeHookConfigError}`);
  }

  if (!installed && missing.length > 0) {
    lines.push("", "Needs attention:", ...missing.map((label) => `- ${label}`));
  }

  lines.push("", "Next steps:");
  if (installed) {
    lines.push("- Restart Copilot CLI after updates.", "- Run /skills reload", "- Run /env", "- Run /mcp show goalSystem", "- Reload VS Code if you use VS Code Chat.");
  } else if (status.runtimeState.status === "stale") {
    lines.push("- Run Copilot Goal System: Install Recommended Setup to update local files.", "- Restart Copilot CLI.", "- Reload VS Code.");
  } else if (summary.cli === "Ready" && summary.vscodeChat !== "Ready") {
    lines.push("- CLI mode is ready.", "- Run Copilot Goal System: Install Recommended Setup if you want VS Code Chat and MCP too.", "- Restart Copilot CLI, then run /skills reload, /env, and /mcp show goalSystem.");
  } else if (summary.vscodeChat === "Ready" && summary.cli !== "Ready") {
    lines.push("- VS Code Chat mode is ready.", "- Run Copilot Goal System: Install Recommended Setup if you want CLI and MCP too.", "- Reload VS Code.");
  } else if (summary.mcp === "Ready" && summary.cli !== "Ready" && summary.vscodeChat !== "Ready") {
    lines.push("- MCP mode is ready.", "- Run Copilot Goal System: Install Recommended Setup if you want CLI hooks and VS Code Chat too.", "- In Copilot CLI, run /mcp show goalSystem.");
  } else {
    lines.push("- Run Copilot Goal System: Install Recommended Setup.", "- Restart Copilot CLI.", "- Reload VS Code.");
  }

  return lines.join("\n");
}

async function showInstallStatus(output, statusBar) {
  const status = await collectStatus();
  const report = formatStatusReport(status);
  output.clear();
  output.appendLine(report);
  output.show(true);
  await updateStatusBar(statusBar, output, status);

  const allOk = statusIsInstalled(status);
  const updateNeeded = status.runtimeState.status === "stale";
  const actions = allOk
    ? ["Open Docs", "Open State Folder"]
    : updateNeeded
      ? ["Update Local Files", "Show Details", "Open Walkthrough"]
      : ["Install Recommended Setup", "Install CLI Only", "Install MCP Only", "Install VS Code Chat Only", "Open Walkthrough"];
  const result = await vscode.window.showInformationMessage(
    allOk
      ? "Copilot Goal System is installed."
      : updateNeeded
        ? "Copilot Goal System local files need an update."
        : "Copilot Goal System is not fully installed.",
    ...actions
  );

  if (result === "Open Docs") await openDocs();
  if (result === "Open State Folder") await revealPath(status.paths.stateRoot, "Goal state folder");
  if (result === "Show Details") output.show(true);
  if (result === "Open Walkthrough") await openWalkthrough();
  if (result === "Update Local Files") await vscode.commands.executeCommand("copilotGoalSystem.install");
  if (result === "Install Recommended Setup") {
    await vscode.commands.executeCommand("copilotGoalSystem.install");
  }
  if (result === "Install CLI Only") await vscode.commands.executeCommand("copilotGoalSystem.installCli");
  if (result === "Install MCP Only") await vscode.commands.executeCommand("copilotGoalSystem.installMcp");
  if (result === "Install VS Code Chat Only") await vscode.commands.executeCommand("copilotGoalSystem.installVscodeChat");
}

async function runActivationPrompts(context, output, statusBar) {
  await maybeOfferFirstInstall(context, output, statusBar);
  await maybeOfferRuntimeUpdate(context, output, statusBar);
}

async function maybeOfferFirstInstall(context, output, statusBar) {
  if (installInProgress || context.globalState.get(FIRST_INSTALL_PROMPT_KEY)) return;
  if (!config().get("promptOnFirstRun", true)) return;

  const status = await collectStatus();
  await updateStatusBar(statusBar, output, status);
  if (status.runtimeState.status === "stale") return;
  const allOk = statusIsInstalled(status);
  if (allOk) {
    await context.globalState.update(FIRST_INSTALL_PROMPT_KEY, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Set up persisted goal mode for Copilot CLI and VS Code Copilot Chat.",
    "Set Up Now",
    "Open Walkthrough",
    "Show Status",
    "Don't Ask Again"
  );

  await context.globalState.update(FIRST_INSTALL_PROMPT_KEY, true);

  if (choice === "Set Up Now") {
    await vscode.commands.executeCommand("copilotGoalSystem.install");
  } else if (choice === "Open Walkthrough") {
    await openWalkthrough();
  } else if (choice === "Show Status") {
    await showInstallStatus(output, statusBar);
  }
}

async function maybeOfferRuntimeUpdate(context, output, statusBar) {
  if (installInProgress || !config().get("promptOnUpdate", true)) return;

  const status = await collectStatus();
  await updateStatusBar(statusBar, output, status);
  if (status.runtimeState.status !== "stale") return;

  const promptKey = runtimeUpdatePromptKey(status.paths.home, status.bundledVersion);
  if (context.globalState.get(promptKey)) return;

  const choice = await vscode.window.showInformationMessage(
    `Copilot Goal System ${status.bundledVersion} has newer local runtime files. Installed local files are ${status.installedVersion || "unknown"}.`,
    "Update Local Files",
    "Show Status",
    "Later"
  );

  if (choice === "Update Local Files") {
    await vscode.commands.executeCommand("copilotGoalSystem.install");
  } else if (choice === "Show Status") {
    await context.globalState.update(promptKey, true);
    await showInstallStatus(output, statusBar);
  } else {
    await context.globalState.update(promptKey, true);
  }
}

async function updateStatusBar(statusBar, output, knownStatus) {
  if (!statusBar) return;
  if (!config().get("showStatusBar", true)) {
    statusBar.hide();
    return;
  }

  try {
    const status = knownStatus || await collectStatus();
    const installed = statusIsInstalled(status);
    const missing = missingChecks(status);
    const summary = surfaceSummary(status);
    const updateNeeded = status.runtimeState.status === "stale";
    statusBar.command = "copilotGoalSystem.status";
    statusBar.text = installed
      ? "$(target) Goal"
      : updateNeeded
        ? "$(sync) Goal Update"
        : summary.cli === "Ready" && summary.vscodeChat !== "Ready"
          ? "$(target) Goal CLI"
          : summary.vscodeChat === "Ready" && summary.cli !== "Ready"
            ? "$(target) Goal VS"
            : summary.mcp === "Ready" && summary.cli !== "Ready" && summary.vscodeChat !== "Ready"
              ? "$(target) Goal MCP"
            : "$(warning) Goal Setup";
    statusBar.tooltip = installed
      ? `${DISPLAY_NAME} is installed for ${status.paths.home}. Click to show status.`
      : updateNeeded
        ? `${DISPLAY_NAME} local files are ${status.installedVersion || "unknown"}; extension bundle is ${status.bundledVersion}. Click to update.`
        : `${DISPLAY_NAME}: CLI ${summary.cli}; VS Code Chat ${summary.vscodeChat}; MCP ${summary.mcp}; Runtime ${summary.runtime}. Needs attention: ${missing.join(", ") || "none"}. Click to show status.`;
    statusBar.show();
  } catch (error) {
    statusBar.command = "copilotGoalSystem.status";
    statusBar.text = "$(error) Goal Setup";
    statusBar.tooltip = `${DISPLAY_NAME} status check failed: ${error.message || String(error)}`;
    statusBar.show();
    output.appendLine(`Status bar update failed: ${error.message || String(error)}`);
  }
}

function setStatusBarInstalling(statusBar) {
  if (!statusBar || !config().get("showStatusBar", true)) return;
  statusBar.command = "copilotGoalSystem.status";
  statusBar.text = "$(sync~spin) Goal Setup";
  statusBar.tooltip = "Installing Copilot Goal System into local Copilot profiles.";
  statusBar.show();
}

function commandEnv(home, copilotRoot) {
  const env = { ...process.env };
  env.HOME = home;
  env.USERPROFILE = home;
  env.COPILOT_HOME = copilotRoot;
  return env;
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function runStreaming(command, args, options, output) {
  return new Promise((resolve, reject) => {
    output.appendLine(`$ ${command} ${args.join(" ")}`);
    const child = cp.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.append(chunk));
    child.stderr.on("data", (chunk) => output.append(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function assertNode20(output, env) {
  let version = "";
  try {
    version = await capture("node", ["--version"], { env });
  } catch (error) {
    output.appendLine(error && error.message ? error.message : String(error));
    throw new Error("Node.js was not found on PATH. Install Node.js 20 or newer, then run install again.");
  }

  const major = Number((version.match(/^v?(\d+)/) || [])[1] || 0);
  output.appendLine(`Node.js: ${version}`);
  if (major < 20) {
    throw new Error(`Node.js 20 or newer is required. Current version: ${version}`);
  }
}

const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000;

function installLockFilePath(copilotRoot) {
  return path.join(copilotRoot, "extensions", ".goal-system.install.lock");
}

// Claims the cross-process install lock. Returns the lock file path on success,
// or null when a fresh lock already belongs to another window/process.
async function acquireInstallLock(copilotRoot) {
  const lockFile = installLockFilePath(copilotRoot);
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  try {
    await fsp.writeFile(lockFile, String(process.pid), { flag: "wx" });
    return lockFile;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let stats;
  try {
    stats = await fsp.stat(lockFile);
  } catch {
    stats = null;
  }
  if (stats && Date.now() - stats.mtimeMs < INSTALL_LOCK_STALE_MS) {
    return null;
  }

  await fsp.rm(lockFile, { force: true });
  await fsp.writeFile(lockFile, String(process.pid), { flag: "wx" });
  return lockFile;
}

async function installGoalSystem(context, output, statusBar, target) {
  if (installInProgress) {
    vscode.window.showInformationMessage("Copilot Goal System install is already running.");
    return;
  }

  const paths = installedPaths();
  const script = installerPath(context);

  if (!fs.existsSync(script)) {
    vscode.window.showErrorMessage("The bundled goal-system installer is missing. Reinstall this VS Code extension and try again.");
    return;
  }

  let lockFile;
  try {
    lockFile = await acquireInstallLock(paths.copilotRoot);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not create the install lock: ${error.message || String(error)}`);
    return;
  }
  if (!lockFile) {
    vscode.window.showInformationMessage("Another VS Code window is already installing Copilot Goal System. Try again once it finishes.");
    return;
  }

  output.clear();
  output.show(true);
  output.appendLine(`${DISPLAY_NAME} installer`);
  output.appendLine(`Target: ${target}`);
  output.appendLine(`Home: ${paths.home}`);
  output.appendLine(`Bundle: ${bundleRoot(context)}`);
  output.appendLine("");

  installInProgress = true;
  setStatusBarInstalling(statusBar);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing Copilot Goal System",
        cancellable: false,
      },
      async (progress) => {
        const env = commandEnv(paths.home, paths.copilotRoot);
        progress.report({ message: "Checking Node.js" });
        await assertNode20(output, env);
        progress.report({ message: "Copying files and installing dependencies" });
        await runStreaming("node", [script, "--target", target], { cwd: bundleRoot(context), env }, output);
      }
    );

    await updateStatusBar(statusBar, output);
    if (config().get("showStatusAfterInstall", true)) {
      await showInstallStatus(output, statusBar);
    } else {
      vscode.window.showInformationMessage("Copilot Goal System installed. Restart Copilot CLI and reload VS Code if you use both adapters.");
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    output.appendLine("");
    output.appendLine(`Install failed: ${message}`);
    output.show(true);
    await updateStatusBar(statusBar, output);
    vscode.window.showErrorMessage(`Copilot Goal System install failed: ${message}`);
  } finally {
    installInProgress = false;
    await fsp.rm(lockFile, { force: true }).catch(() => {});
  }
}

async function copyRuntimePrompt(context) {
  const promptPath = path.join(bundleRoot(context), "tests", "prompts", "goal-system-reliability-e2e.md");
  try {
    const prompt = await fsp.readFile(promptPath, "utf8");
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage("Runtime E2E prompt copied. Paste it into Copilot after installing the goal system.");
  } catch (error) {
    vscode.window.showErrorMessage(`Could not copy the runtime prompt: ${error.message || String(error)}`);
  }
}

async function openDocs() {
  await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
}

async function openWalkthrough() {
  try {
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", "gabrimatic.copilot-goal-system#copilotGoalSystem.setup", false);
  } catch {
    await openDocs();
  }
}

async function revealPath(filePath, label) {
  try {
    if (!await exists(filePath)) {
      const actions = label === "Goal state folder" ? ["Show Status"] : ["Show Status", "Install Recommended Setup"];
      const result = await vscode.window.showInformationMessage(
        label === "Goal state folder" ? `${label} does not exist yet. It appears after a goal runs.` : `${label} does not exist yet.`,
        ...actions
      );
      if (result === "Show Status") await vscode.commands.executeCommand("copilotGoalSystem.status");
      if (result === "Install Recommended Setup") await vscode.commands.executeCommand("copilotGoalSystem.install");
      return;
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open ${filePath}: ${error.message || String(error)}`);
  }
}

module.exports = {
  activate,
  deactivate,
  surfaceSummary,
  resolveCopilotRoot,
  acquireInstallLock,
};
