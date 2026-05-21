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

module.exports = {
  countDuplicateGoalHooks,
  findStaleDriftHookEvents,
  hookCommandText,
  hookInstalled,
  isDirectGoalContextHook,
  isGoalContextHook,
  isGoalSystemOwnedHook,
};
