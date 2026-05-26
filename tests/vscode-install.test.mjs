import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse as parseJsonc } from "jsonc-parser";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const installer = path.join(root, "scripts", "install.mjs");
process.env.GOAL_SYSTEM_TEST_LINK_NODE_MODULES = path.join(root, "node_modules");

test("installer can add VS Code Chat adapter and remove only legacy goalSystem server", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-"));
  const mcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(mcpConfigPath)]);
  await writeFile(
    mcpConfigPath,
    JSON.stringify(
      {
        servers: {
          existingServer: {
            type: "stdio",
            command: "node",
            args: ["existing.mjs"],
          },
          goalSystem: {
            type: "stdio",
            command: "node",
            args: ["/tmp/old/mcp-server.mjs"],
          },
        },
      },
      null,
      2
    )
  );

  await execFileAsync(process.execPath, [installer, "--target", "vscode-chat", "--vscode-mcp-config", mcpConfigPath], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  const hookConfig = JSON.parse(await readFile(path.join(home, ".copilot", "hooks", "goal-system-vscode.json"), "utf8"));
  assert.equal(hookConfig.hooks.Stop[0].type, "command");
  assert.match(hookConfig.hooks.Stop[0].command, /hook-runner\.mjs/);
  assert.equal(Boolean(hookConfig.hooks.UserPromptSubmit), true);
  assert.equal(Boolean(hookConfig.hooks.PreToolUse), true);
  assert.equal(Boolean(hookConfig.hooks.SubagentStart), true);

  const agent = await readFile(path.join(home, ".copilot", "agents", "goal-system.agent.md"), "utf8");
  assert.match(agent, /name: Goal System/);
  assert.match(agent, /goal_system_open/);
  assert.match(agent, /goalctl/);
  assert.match(agent, /main-session only/);

  const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(mcpConfig.servers.existingServer.command, "node");
  assert.equal(mcpConfig.servers.goalSystem, undefined);

  const findResult = await execFileAsync("find", [path.dirname(mcpConfigPath), "-name", "*.backup-*"], { encoding: "utf8" });
  assert.match(findResult.stdout, /mcp\.json\.backup-/);

  await rm(home, { recursive: true, force: true });
});

test("installer ignores corrupt legacy VS Code server config while installing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-bad-json-"));
  const mcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(mcpConfigPath)]);
  await writeFile(mcpConfigPath, "{bad json");

  const { stderr } = await execFileAsync(process.execPath, [installer, "--target", "vscode-chat", "--vscode-mcp-config", mcpConfigPath], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  assert.match(stderr, /could not be inspected for legacy VS Code MCP server/);
  const backups = await execFileAsync("find", [home, "-name", "mcp.json.invalid-backup-*"], { encoding: "utf8" });
  assert.equal(backups.stdout.trim(), "");
  assert.equal(await readFile(mcpConfigPath, "utf8"), "{bad json");

  await rm(home, { recursive: true, force: true });
});

test("installer accepts VS Code server JSONC and removes legacy goalSystem without stripping comments", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-jsonc-"));
  const mcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(mcpConfigPath)]);
  await writeFile(
    mcpConfigPath,
    `{
  // VS Code server config is commonly edited as JSONC.
  "servers": {
    "existingServer": { "type": "stdio", "command": "node", "args": ["existing.mjs"] },
    "goalSystem": { "type": "stdio", "command": "node", "args": ["/tmp/old/mcp-server.mjs"] },
  },
}
`
  );

  await execFileAsync(process.execPath, [installer, "--target", "vscode-chat", "--vscode-mcp-config", mcpConfigPath], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  const raw = await readFile(mcpConfigPath, "utf8");
  assert.match(raw, /VS Code server config is commonly edited as JSONC/);
  const mcpConfig = parseJsonc(raw);
  assert.equal(mcpConfig.servers.existingServer.command, "node");
  assert.equal(mcpConfig.servers.goalSystem, undefined);

  await rm(home, { recursive: true, force: true });
});

test("installer leaves an empty legacy VS Code server config untouched", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-empty-json-"));
  const mcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(mcpConfigPath)]);
  await writeFile(mcpConfigPath, "");

  await execFileAsync(process.execPath, [installer, "--target", "vscode-chat", "--vscode-mcp-config", mcpConfigPath], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  assert.equal(await readFile(mcpConfigPath, "utf8"), "");

  await rm(home, { recursive: true, force: true });
});
