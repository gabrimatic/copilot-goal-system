"use strict";

const path = require("node:path");
const os = require("node:os");

function hookCommandText(hook) {
  return [hook && hook.bash, hook && hook.command, hook && hook.windows].filter(Boolean).join(" ");
}

function quoteTrimmed(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function normalizeDirectGoalCommand(value, home = os.homedir()) {
  const text = quoteTrimmed(value);
  if (text === "~/.copilot/hooks/goal-context.sh") return "$HOME/.copilot/hooks/goal-context.sh";
  if (text === "${HOME}/.copilot/hooks/goal-context.sh") return "$HOME/.copilot/hooks/goal-context.sh";
  if (text === path.join(home, ".copilot", "hooks", "goal-context.sh")) return "$HOME/.copilot/hooks/goal-context.sh";
  return text;
}

function isGoalContextHook(hook) {
  const text = hookCommandText(hook);
  return /(?:^|[\s"'`])(?:~|\$HOME|\$\{HOME\}|[^\s"'`]+)\/\.copilot\/hooks\/goal-context\.sh(?:$|[\s"'`])/.test(text);
}

function isDirectGoalContextHook(hook, home = os.homedir()) {
  if (!hook || hook.type !== "command") return false;
  const fields = [hook.bash, hook.command, hook.windows].filter(Boolean);
  if (fields.length !== 1) return false;
  return normalizeDirectGoalCommand(fields[0], home) === "$HOME/.copilot/hooks/goal-context.sh";
}

function hookInstalled(settings, eventName) {
  const hooks = settings && settings.hooks && Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  return hooks.some((hook) => hook && hook.type === "command" && isGoalContextHook(hook));
}

function countGoalHooks(settings, eventName) {
  const hooks = settings && settings.hooks && Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  return hooks.filter((hook) => hook && hook.type === "command" && isGoalContextHook(hook)).length;
}

function countDuplicateGoalHooks(settings, eventNames) {
  const duplicates = {};
  for (const eventName of eventNames) {
    const count = countGoalHooks(settings, eventName);
    if (count > 1) duplicates[eventName] = count - 1;
  }
  return duplicates;
}

function isGoalSystemOwnedHook(hook) {
  return isGoalContextHook(hook) || /(?:goal-system|hook-runner\.mjs)/.test(hookCommandText(hook));
}

function findStaleDriftHookEvents(settings) {
  const events = [];
  const hooks = settings && settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const eventName of ["preToolUse", "postToolUse", "PreToolUse", "PostToolUse"]) {
    const eventHooks = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    if (eventHooks.some(isGoalSystemOwnedHook)) events.push(eventName);
  }
  return events;
}

function expandHomePath(value, home = os.homedir()) {
  const text = String(value || "");
  if (text === "~") return home;
  if (text.startsWith("~/")) return path.join(home, text.slice(2));
  return text;
}

function resolveMaybePath(value, home = os.homedir()) {
  const expanded = expandHomePath(value, home);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
}

function cliMcpServerDetails(config, options = {}) {
  const expectedScriptPath = options.expectedScriptPath ? resolveMaybePath(options.expectedScriptPath, options.home) : "";
  const server = config && config.mcpServers && config.mcpServers.goalSystem;
  if (!server || !Array.isArray(server.args)) {
    return { ok: false, reason: "goalSystem server is missing or has no args" };
  }
  const command = String(server.command || "");
  const type = String(server.type || "");
  if (!command) return { ok: false, reason: "goalSystem command is missing" };
  if (type !== "local" && type !== "stdio") return { ok: false, reason: `goalSystem type is ${type || "missing"}` };

  const scriptArg = server.args.find((arg) => /mcp-server\.mjs$/.test(String(arg)));
  if (!scriptArg) return { ok: false, reason: "goalSystem args do not point at mcp-server.mjs" };

  const resolvedScriptPath = resolveMaybePath(scriptArg, options.home);
  if (expectedScriptPath && resolvedScriptPath !== expectedScriptPath) {
    return {
      ok: false,
      reason: `goalSystem points at ${resolvedScriptPath}, expected ${expectedScriptPath}`,
      command,
      args: server.args,
      env: server.env && typeof server.env === "object" ? server.env : {},
      scriptPath: resolvedScriptPath,
    };
  }

  const toolsOk = !Array.isArray(server.tools) || server.tools.includes("*") || server.tools.some((tool) => /^goal_system_/.test(String(tool)));
  if (!toolsOk) return { ok: false, reason: "goalSystem tools filter does not expose goal_system_* tools" };

  return {
    ok: true,
    reason: "configured",
    command,
    args: server.args,
    env: server.env && typeof server.env === "object" ? server.env : {},
    scriptPath: resolvedScriptPath,
  };
}

function cliMcpServerInstalled(config, options = {}) {
  return cliMcpServerDetails(config, options).ok;
}

module.exports = {
  cliMcpServerDetails,
  cliMcpServerInstalled,
  countDuplicateGoalHooks,
  findStaleDriftHookEvents,
  hookCommandText,
  hookInstalled,
  isDirectGoalContextHook,
  isGoalContextHook,
  isGoalSystemOwnedHook,
};
