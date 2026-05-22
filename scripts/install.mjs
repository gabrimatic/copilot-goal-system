#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseJsoncText, updateJsoncPath } = require("../lib/jsonc-file.cjs");
const { isBundledRuntimePath } = require("../lib/runtime-bundle.cjs");
const { copilotRootForHome } = require("../lib/copilot-paths.cjs");
const home = os.homedir();
const copilotRoot = copilotRootForHome(home);
const extensionDir = path.join(copilotRoot, "extensions", "goal-system");
const skillDir = path.join(copilotRoot, "skills", "goal");
const hookDir = path.join(copilotRoot, "hooks");
const agentDir = path.join(copilotRoot, "agents");
const settingsPath = path.join(copilotRoot, "settings.json");
const cliMcpConfigPath = path.join(copilotRoot, "mcp-config.json");
const instructionsPath = path.join(copilotRoot, "copilot-instructions.md");
const vscodeHookConfigPath = path.join(hookDir, "goal-system-vscode.json");
const vscodeAgentPath = path.join(agentDir, "goal-system.agent.md");
const markerStart = "<!-- copilot-goal-system snippet start -->";
const markerEnd = "<!-- copilot-goal-system snippet end -->";

function goalContextCommand() {
  return copilotRoot === path.join(home, ".copilot") ? "$HOME/.copilot/hooks/goal-context.sh" : "$COPILOT_HOME/hooks/goal-context.sh";
}

function hookEvents() {
  const bash = goalContextCommand();
  return {
    sessionStart: [{ type: "command", bash, timeoutSec: 5 }],
    userPromptSubmitted: [{ type: "command", bash, timeoutSec: 5 }],
    preCompact: [{ type: "command", bash, timeoutSec: 5 }],
    agentStop: [{ type: "command", bash, timeoutSec: 5 }],
    subagentStart: [{ type: "command", bash, timeoutSec: 5 }],
    subagentStop: [{ type: "command", bash, timeoutSec: 5 }],
    postToolUseFailure: [{ type: "command", bash, timeoutSec: 5 }],
    notification: [
      {
        type: "command",
        bash,
        matcher: "agent_idle|agent_completed",
        timeoutSec: 5,
      },
    ],
  };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const options = {
    target: "cli",
    vscodeMcpConfigPath: process.env.GOAL_SYSTEM_VSCODE_MCP_CONFIG_PATH || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      options.target = argv[index + 1] || options.target;
      index += 1;
    } else if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    } else if (arg === "--vscode-mcp-config") {
      options.vscodeMcpConfigPath = argv[index + 1] || options.vscodeMcpConfigPath;
      index += 1;
    } else if (arg.startsWith("--vscode-mcp-config=")) {
      options.vscodeMcpConfigPath = arg.slice("--vscode-mcp-config=".length);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));

function selectedTargets(target) {
  if (target === "all") return new Set(["cli", "vscode-chat"]);
  if (target === "cli" || target === "vscode-chat") return new Set([target]);
  throw new Error(`Unknown install target "${target}". Use cli, vscode-chat, or all.`);
}

async function readJsonDocumentIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return { raw, value: parseJsoncText(raw, filePath), exists: true };
  } catch (error) {
    if (error.code === "ENOENT") return { raw: "{}\n", value: {}, exists: false };
    throw error;
  }
}

async function recoverInvalidJsonObjectDocument(filePath, raw, description, reason) {
  const backupPath = `${filePath}.invalid-backup-${stamp()}-${process.pid}`;
  const trimmedReason = String(reason).replace(/[.?!]\s*$/, "");
  const mode = await fileModeForWrite(filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(backupPath, raw, { encoding: "utf8", mode });
  await writeTextAtomic(filePath, "{}\n", { backup: false });
  process.stderr.write(
    `${filePath} could not be used as ${description}: ${trimmedReason}. ` +
      `Backed up the original file to ${backupPath} and recreated a clean JSON object.\n`
  );
  return { raw: "{}\n", value: {}, exists: true, recovered: true, backupPath };
}

async function readEditableJsonObjectDocument(filePath, description) {
  let document;
  try {
    document = await readJsonDocumentIfExists(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const raw = await readFile(filePath, "utf8");
      return recoverInvalidJsonObjectDocument(
        filePath,
        raw,
        description,
        error.message
      );
    }
    throw error;
  }
  if (!document.value || typeof document.value !== "object" || Array.isArray(document.value)) {
    return recoverInvalidJsonObjectDocument(filePath, document.raw, description, "the file must contain a JSON object");
  }
  return document;
}

async function fileModeForWrite(filePath) {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") return 0o600;
    throw error;
  }
}

async function preflightEditableJsonObjectDocument(filePath) {
  try {
    await readJsonDocumentIfExists(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

async function writeTextAtomic(filePath, text, options = {}) {
  const { backup = true } = options;
  let original = null;
  let mode = 0o600;
  try {
    original = await readFile(filePath, "utf8");
    mode = await fileModeForWrite(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  if (backup && original !== null && original !== text) {
    await writeFile(`${filePath}.backup-${stamp()}`, original, { encoding: "utf8", mode });
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, text, { encoding: "utf8", mode });
  await chmod(tempPath, mode);
  await rename(tempPath, filePath);
}

async function sameFilesystemPath(left, right) {
  const [leftReal, rightReal] = await Promise.all([
    realpath(left).catch(() => path.resolve(left)),
    realpath(right).catch(() => path.resolve(right)),
  ]);
  return leftReal === rightReal;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultVscodeMcpConfigPath() {
  if (options.vscodeMcpConfigPath) return path.resolve(options.vscodeMcpConfigPath);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code", "User", "mcp.json");
}

function sameHook(left, right) {
  return left?.type === right?.type && left?.bash === right?.bash && (left?.matcher || "") === (right?.matcher || "");
}

function hookCommandText(hook) {
  return [hook?.bash, hook?.command, hook?.windows].filter(Boolean).join(" ");
}

function quoteTrimmed(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function normalizeDirectGoalCommand(value) {
  let text = quoteTrimmed(value);
  if (text === "~/.copilot/hooks/goal-context.sh") return goalContextCommand();
  if (text === "$HOME/.copilot/hooks/goal-context.sh") return goalContextCommand();
  if (text === "${HOME}/.copilot/hooks/goal-context.sh") return goalContextCommand();
  if (text === "$COPILOT_HOME/hooks/goal-context.sh") return goalContextCommand();
  if (text === "${COPILOT_HOME}/hooks/goal-context.sh") return goalContextCommand();
  if (text === path.join(home, ".copilot", "hooks", "goal-context.sh")) return goalContextCommand();
  if (text === path.join(copilotRoot, "hooks", "goal-context.sh")) return goalContextCommand();
  return text;
}

function isGoalContextHook(hook) {
  const text = hookCommandText(hook);
  return /(?:^|[\s"'`])(?:(?:~|\$HOME|\$\{HOME\})\/\.copilot|\$COPILOT_HOME|\$\{COPILOT_HOME\}|[^\s"'`]+)\/hooks\/goal-context\.sh(?:$|[\s"'`])/.test(text);
}

function isDirectGoalContextHook(hook) {
  if (!hook || hook.type !== "command") return false;
  const fields = [hook.bash, hook.command, hook.windows].filter(Boolean);
  if (fields.length !== 1) return false;
  return normalizeDirectGoalCommand(fields[0]) === goalContextCommand();
}

function isGoalSystemOwnedHook(hook) {
  return isGoalContextHook(hook) || /(?:goal-system|hook-runner\.mjs)/.test(hookCommandText(hook));
}

function removeStaleCliDriftHooks(settings) {
  for (const eventName of ["preToolUse", "postToolUse", "PreToolUse", "PostToolUse"]) {
    if (!Array.isArray(settings.hooks[eventName])) continue;
    settings.hooks[eventName] = settings.hooks[eventName].filter((hook) => !isGoalSystemOwnedHook(hook));
  }
}

async function mergeSettingsHooks() {
  await mkdir(copilotRoot, { recursive: true });
  const settingsDocument = await readEditableJsonObjectDocument(settingsPath, "Copilot CLI settings");
  const settings = settingsDocument.value;
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  removeStaleCliDriftHooks(settings);

  for (const [eventName, goalHooks] of Object.entries(hookEvents())) {
    const existing = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const hasCompositeGoalHook = existing.some((hook) => isGoalContextHook(hook) && !isDirectGoalContextHook(hook));
    const merged = [];
    let directGoalHookInserted = false;

    for (const existingHook of existing) {
      if (isDirectGoalContextHook(existingHook)) {
        if (!hasCompositeGoalHook && !directGoalHookInserted) {
          merged.push(goalHooks[0]);
          directGoalHookInserted = true;
        }
        continue;
      }
      merged.push(existingHook);
    }

    if (hasCompositeGoalHook || directGoalHookInserted) {
      settings.hooks[eventName] = merged;
      continue;
    }

    for (const hook of goalHooks) {
      if (!merged.some((candidate) => sameHook(candidate, hook))) {
        merged.push(hook);
      }
    }
    settings.hooks[eventName] = merged;
  }

  await writeTextAtomic(settingsPath, updateJsoncPath(settingsDocument.raw, ["hooks"], settings.hooks));
}

async function installCliMcpServer() {
  const mcpDocument = await readEditableJsonObjectDocument(cliMcpConfigPath, "Copilot CLI MCP config");
  const mcpConfig = mcpDocument.value;
  const hadMcpServersObject = mcpConfig.mcpServers && typeof mcpConfig.mcpServers === "object" && !Array.isArray(mcpConfig.mcpServers);
  mcpConfig.mcpServers =
    hadMcpServersObject ? mcpConfig.mcpServers : {};
  const serverConfig = {
    type: "local",
    command: process.execPath,
    args: [path.join(extensionDir, "adapters", "vscode-chat", "mcp-server.mjs")],
    env: {
      GOAL_SYSTEM_ADAPTER: "copilot-cli-mcp",
      COPILOT_HOME: copilotRoot,
      GOAL_SYSTEM_STATE_ROOT: path.join(copilotRoot, "session-state", "goal-system"),
    },
    tools: ["*"],
  };
  mcpConfig.mcpServers.goalSystem = serverConfig;

  await writeTextAtomic(
    cliMcpConfigPath,
    updateJsoncPath(mcpDocument.raw, hadMcpServersObject ? ["mcpServers", "goalSystem"] : ["mcpServers"], hadMcpServersObject ? serverConfig : mcpConfig.mcpServers)
  );
}

async function appendInstructionsSnippet() {
  await mkdir(path.dirname(instructionsPath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(instructionsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (existing.includes(markerStart)) return;

  const snippet = await readFile(path.join(root, "instructions", "copilot-instructions.goal-snippet.md"), "utf8");
  const next = `${existing.trimEnd()}\n\n${markerStart}\n${snippet.trim()}\n${markerEnd}\n`;
  await writeTextAtomic(instructionsPath, next, { backup: Boolean(existing) });
}

async function installFiles() {
  await mkdir(path.dirname(extensionDir), { recursive: true });
  if (!(await sameFilesystemPath(root, extensionDir))) {
    const tempExtensionDir = path.join(path.dirname(extensionDir), `.goal-system-install-${process.pid}-${Date.now()}`);
    const previousExtensionDir = path.join(path.dirname(extensionDir), `.goal-system-previous-${process.pid}-${Date.now()}`);
    let previousMoved = false;
    let tempInstalled = false;
    try {
      await cp(root, tempExtensionDir, {
        recursive: true,
        force: true,
        filter: (source) => {
          const relative = path.relative(root, source);
          if (relative === "vscode-extension") return false;
          return isBundledRuntimePath(source, root);
        },
      });
      await installDependencies(tempExtensionDir);
      await chmodRuntimeExecutables(tempExtensionDir);
      if (await exists(extensionDir)) {
        await rename(extensionDir, previousExtensionDir);
        previousMoved = true;
      }
      await rename(tempExtensionDir, extensionDir);
      tempInstalled = true;
      if (previousMoved) {
        await rm(previousExtensionDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (!tempInstalled) {
        await rm(tempExtensionDir, { recursive: true, force: true }).catch(() => {});
      }
      if (previousMoved && !(await exists(extensionDir))) {
        await rename(previousExtensionDir, extensionDir).catch(() => {});
      }
      throw error;
    }
  } else {
    await installDependencies(extensionDir);
    await chmodRuntimeExecutables(extensionDir);
  }

  await mkdir(skillDir, { recursive: true });
  await mkdir(hookDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  await copyFile(path.join(root, "skills", "goal", "SKILL.md"), path.join(skillDir, "SKILL.md"));
  await copyFile(path.join(root, "hooks", "goal-context.sh"), path.join(hookDir, "goal-context.sh"));
  await chmod(path.join(hookDir, "goal-context.sh"), fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
}

async function chmodRuntimeExecutables(runtimeDir) {
  const executableFiles = [
    path.join(runtimeDir, "adapters", "vscode-chat", "hook-runner.mjs"),
    path.join(runtimeDir, "adapters", "vscode-chat", "mcp-server.mjs"),
  ];
  for (const filePath of executableFiles) {
    await chmod(filePath, fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
  }
}

async function installDependencies(runtimeDir) {
  if (process.env.GOAL_SYSTEM_TEST_LINK_NODE_MODULES) {
    const nodeModulesPath = path.join(runtimeDir, "node_modules");
    await rm(nodeModulesPath, { recursive: true, force: true });
    await symlink(process.env.GOAL_SYSTEM_TEST_LINK_NODE_MODULES, nodeModulesPath, process.platform === "win32" ? "junction" : "dir");
    return;
  }

  const result = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--fund=false", "--prefer-offline"], {
    cwd: runtimeDir,
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT") {
    throw new Error("npm not found. Install Node.js/npm, then rerun ./install.sh.");
  }

  if (result.status !== 0) {
    throw new Error(`npm ci failed in ${runtimeDir}`);
  }
}

async function installVscodeChatAdapter() {
  const hookConfig = await readFile(path.join(root, "adapters", "vscode-chat", "hooks", "goal-system.json"), "utf8");
  await writeTextAtomic(vscodeHookConfigPath, hookConfig.endsWith("\n") ? hookConfig : `${hookConfig}\n`);

  const agent = await readFile(path.join(root, "adapters", "vscode-chat", "agents", "goal-system.agent.md"), "utf8");
  await writeTextAtomic(vscodeAgentPath, agent.endsWith("\n") ? agent : `${agent}\n`);

  const mcpConfigPath = defaultVscodeMcpConfigPath();
  const mcpDocument = await readEditableJsonObjectDocument(mcpConfigPath, "VS Code MCP config");
  const mcpConfig = mcpDocument.value;
  const hadServersObject = mcpConfig.servers && typeof mcpConfig.servers === "object" && !Array.isArray(mcpConfig.servers);
  mcpConfig.servers = hadServersObject ? mcpConfig.servers : {};
  const serverConfig = {
    type: "stdio",
    command: process.execPath,
    args: [path.join(extensionDir, "adapters", "vscode-chat", "mcp-server.mjs")],
    env: {
      GOAL_SYSTEM_ADAPTER: "vscode-chat",
      COPILOT_HOME: copilotRoot,
      GOAL_SYSTEM_STATE_ROOT: path.join(copilotRoot, "session-state", "goal-system"),
    },
  };
  mcpConfig.servers.goalSystem = serverConfig;

  await writeTextAtomic(
    mcpConfigPath,
    updateJsoncPath(mcpDocument.raw, hadServersObject ? ["servers", "goalSystem"] : ["servers"], hadServersObject ? serverConfig : mcpConfig.servers)
  );
  return mcpConfigPath;
}

async function preflightTargetConfigFiles(targets) {
  if (targets.has("cli")) {
    await preflightEditableJsonObjectDocument(settingsPath);
    await preflightEditableJsonObjectDocument(cliMcpConfigPath);
  }
  if (targets.has("vscode-chat")) {
    await preflightEditableJsonObjectDocument(defaultVscodeMcpConfigPath());
  }
}

async function main() {
  const targets = selectedTargets(options.target);
  await preflightTargetConfigFiles(targets);
  await installFiles();

  let vscodeMcpConfigPath = "";
  if (targets.has("cli")) {
    await mergeSettingsHooks();
    await installCliMcpServer();
    await appendInstructionsSnippet();
  }
  if (targets.has("vscode-chat")) {
    vscodeMcpConfigPath = await installVscodeChatAdapter();
  }

  const installedLines = [
    `Installed Copilot Goal System (${[...targets].join(", ")}):`,
    `- ${extensionDir}`,
  ];
  if (targets.has("cli")) {
    installedLines.push(
      `- ${path.join(skillDir, "SKILL.md")}`,
      `- ${path.join(hookDir, "goal-context.sh")}`,
      `- ${settingsPath}`,
      `- ${cliMcpConfigPath}`,
      `- ${instructionsPath}`
    );
  }
  if (targets.has("vscode-chat")) {
    installedLines.push(`- ${vscodeAgentPath}`, `- ${vscodeHookConfigPath}`, `- ${vscodeMcpConfigPath}`);
  }

  const nextSteps = [];
  if (targets.has("cli")) {
    nextSteps.push("Check local health:", `  npm run doctor -- --target ${targets.size > 1 ? "all" : "cli"}`, "Restart Copilot CLI, then run:", "  /skills reload", "  /mcp show", "  /env");
  }
  if (targets.has("vscode-chat")) {
    nextSteps.push("In VS Code, run MCP: Reset Cached Tools or reload the window, then select the Goal System custom agent in Copilot Chat.");
  }

  console.log(`${installedLines.join("\n")}\n\n${nextSteps.join("\n")}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
