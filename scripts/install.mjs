#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
const settingsPath = path.join(copilotRoot, "settings.json");
const instructionsPath = path.join(copilotRoot, "copilot-instructions.md");
const markerStart = "<!-- copilot-goal-system snippet start -->";
const markerEnd = "<!-- copilot-goal-system snippet end -->";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON. Fix it before installing; no settings were changed.`);
    }
    throw error;
  }
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

  if (originalSettings !== null) {
    await writeFile(`${settingsPath}.backup-${stamp()}`, originalSettings, "utf8");
  }

  const tempPath = `${settingsPath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(tempPath, settingsPath);
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
  if (existing) {
    await writeFile(`${instructionsPath}.backup-${stamp()}`, existing, "utf8");
  }

  const tempPath = `${instructionsPath}.tmp-${process.pid}`;
  await writeFile(tempPath, next, "utf8");
  await rename(tempPath, instructionsPath);
}

async function installFiles() {
  await mkdir(extensionDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await mkdir(hookDir, { recursive: true });

  await cp(root, extensionDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = path.relative(root, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      return !parts.includes("node_modules") && !parts.includes(".git");
    },
  });

  await copyFile(path.join(root, "skills", "goal", "SKILL.md"), path.join(skillDir, "SKILL.md"));
  await copyFile(path.join(root, "hooks", "goal-context.sh"), path.join(hookDir, "goal-context.sh"));
  await chmod(path.join(hookDir, "goal-context.sh"), fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
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

async function main() {
  await installFiles();
  installDependencies();
  await mergeSettingsHooks();
  await appendInstructionsSnippet();

  console.log(`Installed Copilot Goal System:
- ${extensionDir}
- ${path.join(skillDir, "SKILL.md")}
- ${path.join(hookDir, "goal-context.sh")}
- ${settingsPath}
- ${instructionsPath}

Restart Copilot CLI, then run:
  /skills reload
  /env`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
