import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const installer = path.join(root, "scripts", "install.mjs");
process.env.GOAL_SYSTEM_TEST_LINK_NODE_MODULES = path.join(root, "node_modules");

test("installer adds the VS Code Chat adapter using local goal files", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-"));

  await execFileAsync(process.execPath, [installer, "--target", "vscode-chat"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  const hookConfig = JSON.parse(await readFile(path.join(home, ".copilot", "hooks", "goal-system-vscode.json"), "utf8"));
  assert.equal(hookConfig.hooks.Stop[0].type, "command");
  assert.match(hookConfig.hooks.Stop[0].command, /hook-runner\.mjs/);
  assert.match(hookConfig.hooks.Stop[0].command, new RegExp(path.join(home, ".copilot", "extensions", "goal-system").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(hookConfig.hooks.Stop[0].command.includes("$HOME"), false);
  assert.equal(Boolean(hookConfig.hooks.UserPromptSubmit), true);
  assert.equal(Boolean(hookConfig.hooks.PreToolUse), true);
  assert.equal(Boolean(hookConfig.hooks.PostToolUse), true);
  assert.equal(Boolean(hookConfig.hooks.SubagentStart), true);

  const agent = await readFile(path.join(home, ".copilot", "agents", "goal-system.agent.md"), "utf8");
  assert.match(agent, /name: Goal System/);
  assert.match(agent, /goal_system_open/);
  assert.match(agent, /goalctl/);
  assert.match(agent, /main-session only/);

  await rm(home, { recursive: true, force: true });
});

test("installer writes VS Code hook commands for a custom COPILOT_HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-home-"));
  const copilotHome = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-copilot-home-"));

  await execFileAsync(process.execPath, [installer, "--target", "vscode-chat"], {
    cwd: root,
    env: { ...process.env, HOME: home, COPILOT_HOME: copilotHome },
    maxBuffer: 1024 * 1024 * 12,
  });

  const hookConfig = JSON.parse(await readFile(path.join(copilotHome, "hooks", "goal-system-vscode.json"), "utf8"));
  assert.match(hookConfig.hooks.PreToolUse[0].command, new RegExp(path.join(copilotHome, "extensions", "goal-system").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(hookConfig.hooks.PreToolUse[0].command.includes("$HOME"), false);

  await rm(home, { recursive: true, force: true });
  await rm(copilotHome, { recursive: true, force: true });
});
