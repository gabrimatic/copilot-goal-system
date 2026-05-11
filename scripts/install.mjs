#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const copilotRoot = path.join(home, ".copilot");
const extensionDir = path.join(copilotRoot, "extensions", "goal-system");
const skillDir = path.join(copilotRoot, "skills", "goal");
const hookDir = path.join(copilotRoot, "hooks");
const agentDir = path.join(copilotRoot, "agents");
const settingsPath = path.join(copilotRoot, "settings.json");
const instructionsPath = path.join(copilotRoot, "copilot-instructions.md");
const vscodeHookConfigPath = path.join(hookDir, "goal-system-vscode.json");
const vscodeAgentPath = path.join(agentDir, "goal-system.agent.md");
const markerStart = "<!-- copilot-goal-system snippet start -->";
const markerEnd = "<!-- copilot-goal-system snippet end -->";

const hookEvents = {
  sessionStart: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }],
  userPromptSubmitted: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }],
  preCompact: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }],
  agentStop: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }],
  subagentStart: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }],
  subagentStop: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }],
  postToolUseFailure: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }],
  notification: [
    {
      type: "command",
      bash: "$HOME/.copilot/hooks/goal-context.sh",
      matcher: "agent_idle|agent_completed",
      timeoutSec: 5,
    },
  ],
};

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

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON. Fix it before installing; no settings were changed.`);
    }
    throw error;
  }
}

async function writeTextAtomic(filePath, text, options = {}) {
  const { backup = true } = options;
  let original = null;
  try {
    original = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  if (backup && original !== null && original !== text) {
    await writeFile(`${filePath}.backup-${stamp()}`, original, "utf8");
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, text, "utf8");
  await rename(tempPath, filePath);
}

async function sameFilesystemPath(left, right) {
  const [leftReal, rightReal] = await Promise.all([
    realpath(left).catch(() => path.resolve(left)),
    realpath(right).catch(() => path.resolve(right)),
  ]);
  return leftReal === rightReal;
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

async function mergeSettingsHooks() {
  await mkdir(copilotRoot, { recursive: true });
  let originalSettings = null;
  try {
    originalSettings = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const settings = await readJsonIfExists(settingsPath);
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

  for (const [eventName, goalHooks] of Object.entries(hookEvents)) {
    const existing = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const merged = [...existing];
    for (const hook of goalHooks) {
      if (!merged.some((candidate) => sameHook(candidate, hook))) {
        merged.push(hook);
      }
    }
    settings.hooks[eventName] = merged;
  }

  await writeTextAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
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
    try {
      await cp(root, tempExtensionDir, {
        recursive: true,
        force: true,
        filter: (source) => {
          const relative = path.relative(root, source);
          if (!relative) return true;
          const parts = relative.split(path.sep);
          return !parts.includes("node_modules") && !parts.includes(".git") && !parts.includes("dist") && !parts.includes("vscode-extension");
        },
      });
      await rm(extensionDir, { recursive: true, force: true });
      await rename(tempExtensionDir, extensionDir);
    } catch (error) {
      await rm(tempExtensionDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  await mkdir(skillDir, { recursive: true });
  await mkdir(hookDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  await copyFile(path.join(root, "skills", "goal", "SKILL.md"), path.join(skillDir, "SKILL.md"));
  await copyFile(path.join(root, "hooks", "goal-context.sh"), path.join(hookDir, "goal-context.sh"));

  const executableFiles = [
    path.join(hookDir, "goal-context.sh"),
    path.join(extensionDir, "adapters", "vscode-chat", "hook-runner.mjs"),
    path.join(extensionDir, "adapters", "vscode-chat", "mcp-server.mjs"),
  ];
  for (const filePath of executableFiles) {
    await chmod(filePath, fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
  }
}

function installDependencies() {
  const result = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
    cwd: extensionDir,
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT") {
    throw new Error("npm not found. Install Node.js/npm, then rerun ./install.sh.");
  }

  if (result.status !== 0) {
    throw new Error(`npm ci failed in ${extensionDir}`);
  }
}

async function installVscodeChatAdapter() {
  const hookConfig = await readFile(path.join(root, "adapters", "vscode-chat", "hooks", "goal-system.json"), "utf8");
  await writeTextAtomic(vscodeHookConfigPath, hookConfig.endsWith("\n") ? hookConfig : `${hookConfig}\n`);

  const agent = await readFile(path.join(root, "adapters", "vscode-chat", "agents", "goal-system.agent.md"), "utf8");
  await writeTextAtomic(vscodeAgentPath, agent.endsWith("\n") ? agent : `${agent}\n`);

  const mcpConfigPath = defaultVscodeMcpConfigPath();
  const mcpConfig = await readJsonIfExists(mcpConfigPath);
  mcpConfig.servers = mcpConfig.servers && typeof mcpConfig.servers === "object" && !Array.isArray(mcpConfig.servers) ? mcpConfig.servers : {};
  mcpConfig.servers.goalSystem = {
    type: "stdio",
    command: process.execPath,
    args: [path.join(extensionDir, "adapters", "vscode-chat", "mcp-server.mjs")],
    env: {
      GOAL_SYSTEM_ADAPTER: "vscode-chat",
    },
  };

  await writeTextAtomic(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
  return mcpConfigPath;
}

async function main() {
  const targets = selectedTargets(options.target);
  await installFiles();
  installDependencies();

  let vscodeMcpConfigPath = "";
  if (targets.has("cli")) {
    await mergeSettingsHooks();
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
      `- ${instructionsPath}`
    );
  }
  if (targets.has("vscode-chat")) {
    installedLines.push(`- ${vscodeAgentPath}`, `- ${vscodeHookConfigPath}`, `- ${vscodeMcpConfigPath}`);
  }

  const nextSteps = [];
  if (targets.has("cli")) {
    nextSteps.push("Restart Copilot CLI, then run:", "  /skills reload", "  /env");
  }
  if (targets.has("vscode-chat")) {
    nextSteps.push("In VS Code, run MCP: Reset Cached Tools or reload the window, then select the Goal System custom agent in Copilot Chat.");
  }

  console.log(`${installedLines.join("\n")}\n\n${nextSteps.join("\n")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
