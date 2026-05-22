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

async function assertCommandFails(commandPromise, pattern) {
  try {
    await commandPromise;
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
    assert.match(output, pattern);
    return error;
  }
  assert.fail("Expected command to fail.");
}

test("installer can add VS Code Chat adapter without overwriting existing MCP servers", async () => {
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
  assert.match(agent, /main-session only/);

  const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(mcpConfig.servers.existingServer.command, "node");
  assert.equal(mcpConfig.servers.goalSystem.type, "stdio");
  assert.match(mcpConfig.servers.goalSystem.args[0], /mcp-server\.mjs/);
  assert.equal(mcpConfig.servers.goalSystem.env.GOAL_SYSTEM_ADAPTER, "vscode-chat");

  const findResult = await execFileAsync("find", [path.dirname(mcpConfigPath), "-name", "*.backup-*"], { encoding: "utf8" });
  assert.match(findResult.stdout, /mcp\.json\.backup-/);

  await rm(home, { recursive: true, force: true });
});

test("installer refuses corrupt VS Code MCP config instead of overwriting it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-bad-json-"));
  const mcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(mcpConfigPath)]);
  await writeFile(mcpConfigPath, "{bad json");

  await assertCommandFails(
    execFileAsync(process.execPath, [installer, "--target", "vscode-chat", "--vscode-mcp-config", mcpConfigPath], {
      cwd: root,
      env: { ...process.env, HOME: home },
      maxBuffer: 1024 * 1024 * 12,
    }),
    /not valid JSON/
  );

  assert.equal(await readFile(mcpConfigPath, "utf8"), "{bad json");

  await rm(home, { recursive: true, force: true });
});

test("installer accepts VS Code MCP JSONC without stripping existing comments", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-jsonc-"));
  const mcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(mcpConfigPath)]);
  await writeFile(
    mcpConfigPath,
    `{
  // VS Code MCP config is commonly edited as JSONC.
  "servers": {
    "existingServer": { "type": "stdio", "command": "node", "args": ["existing.mjs"] },
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
  assert.match(raw, /VS Code MCP config is commonly edited as JSONC/);
  const mcpConfig = parseJsonc(raw);
  assert.equal(mcpConfig.servers.existingServer.command, "node");
  assert.equal(mcpConfig.servers.goalSystem.type, "stdio");
  assert.match(mcpConfig.servers.goalSystem.args[0], /mcp-server\.mjs/);

  await rm(home, { recursive: true, force: true });
});

test("installer treats an empty VS Code MCP config as an empty MCP object", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-vscode-install-empty-json-"));
  const mcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(mcpConfigPath)]);
  await writeFile(mcpConfigPath, "");

  await execFileAsync(process.execPath, [installer, "--target", "vscode-chat", "--vscode-mcp-config", mcpConfigPath], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(mcpConfig.servers.goalSystem.type, "stdio");
  assert.match(mcpConfig.servers.goalSystem.args[0], /mcp-server\.mjs/);

  await rm(home, { recursive: true, force: true });
});
