import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const installer = path.join(root, "scripts", "install.mjs");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

test("installer merges hooks, writes backups, and preserves existing settings", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-test-"));
  const copilotDir = path.join(home, ".copilot");
  await writeFile(
    path.join(copilotDir, "settings.json"),
    JSON.stringify(
      {
        theme: "auto",
        hooks: {
          sessionStart: [{ type: "command", bash: "$HOME/.copilot/hooks/existing.sh", timeoutSec: 1 }],
        },
      },
      null,
      2
    ),
    { flag: "w" }
  ).catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    await execFileAsync("mkdir", ["-p", copilotDir]);
    await writeFile(
      path.join(copilotDir, "settings.json"),
      JSON.stringify(
        {
          theme: "auto",
          hooks: {
            sessionStart: [{ type: "command", bash: "$HOME/.copilot/hooks/existing.sh", timeoutSec: 1 }],
          },
        },
        null,
        2
      )
    );
  });

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const settings = JSON.parse(await readFile(path.join(copilotDir, "settings.json"), "utf8"));
  assert.equal(settings.theme, "auto");
  assert.equal(settings.hooks.sessionStart.some((hook) => hook.bash === "$HOME/.copilot/hooks/existing.sh"), true);
  assert.equal(settings.hooks.sessionStart.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);

  const cliMcpConfig = JSON.parse(await readFile(path.join(copilotDir, "mcp-config.json"), "utf8"));
  assert.equal(cliMcpConfig.mcpServers.goalSystem.type, "local");
  assert.match(cliMcpConfig.mcpServers.goalSystem.args[0], /mcp-server\.mjs/);
  assert.deepEqual(cliMcpConfig.mcpServers.goalSystem.tools, ["*"]);

  const snippet = await readFile(path.join(copilotDir, "copilot-instructions.md"), "utf8");
  assert.match(snippet, /copilot-goal-system snippet start/);

  const installedPackage = JSON.parse(await readFile(path.join(copilotDir, "extensions", "goal-system", "package.json"), "utf8"));
  assert.equal(installedPackage.version, rootPackage.version);

  await assert.rejects(readFile(path.join(copilotDir, "extensions", "goal-system", "vscode-extension", "package.json"), "utf8"), /ENOENT/);
  await assert.rejects(
    readFile(path.join(copilotDir, "extensions", "goal-system", "dist", `copilot-goal-system-${rootPackage.version}.vsix`), "utf8"),
    /ENOENT/
  );

  const findResult = await execFileAsync("find", [copilotDir, "-name", "*.backup-*"], { encoding: "utf8" });
  assert.match(findResult.stdout, /settings\.json\.backup-/);

  await rm(home, { recursive: true, force: true });
});

test("installer adds CLI MCP goal server without overwriting existing MCP servers", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-cli-mcp-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(
    path.join(copilotDir, "mcp-config.json"),
    JSON.stringify(
      {
        mcpServers: {
          playwright: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@playwright/mcp@latest"],
            tools: ["*"],
          },
        },
      },
      null,
      2
    )
  );

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const cliMcpConfig = JSON.parse(await readFile(path.join(copilotDir, "mcp-config.json"), "utf8"));
  assert.equal(cliMcpConfig.mcpServers.playwright.command, "npx");
  assert.equal(cliMcpConfig.mcpServers.goalSystem.type, "local");
  assert.match(cliMcpConfig.mcpServers.goalSystem.args[0], /mcp-server\.mjs/);
  assert.equal(cliMcpConfig.mcpServers.goalSystem.env.GOAL_SYSTEM_ADAPTER, "copilot-cli-mcp");

  const findResult = await execFileAsync("find", [copilotDir, "-name", "mcp-config.json.backup-*"], { encoding: "utf8" });
  assert.match(findResult.stdout, /mcp-config\.json\.backup-/);

  await rm(home, { recursive: true, force: true });
});

test("installer refuses corrupt CLI MCP config instead of overwriting it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-cli-mcp-bad-json-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(path.join(copilotDir, "mcp-config.json"), "{bad json");

  await assert.rejects(
    execFileAsync(process.execPath, [installer], {
      cwd: root,
      env: { ...process.env, HOME: home },
      maxBuffer: 1024 * 1024 * 8,
    }),
    /not valid JSON/
  );

  assert.equal(await readFile(path.join(copilotDir, "mcp-config.json"), "utf8"), "{bad json");
  await assert.rejects(readFile(path.join(copilotDir, "extensions", "goal-system", "package.json"), "utf8"), /ENOENT/);

  await rm(home, { recursive: true, force: true });
});

test("installer removes stale CLI preToolUse goal-system drift hooks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-stale-drift-hook-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(
    path.join(copilotDir, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          preToolUse: [
            {
              type: "command",
              bash: "$HOME/.copilot/hooks/goal-context.sh",
              timeoutSec: 5,
            },
            {
              type: "command",
              bash: "$HOME/.copilot/hooks/keep-this-user-hook.sh",
              timeoutSec: 5,
            },
          ],
          postToolUse: [
            {
              type: "command",
              command: "node \"$HOME/.copilot/extensions/goal-system/adapters/vscode-chat/hook-runner.mjs\"",
              timeoutSec: 5,
            },
          ],
        },
      },
      null,
      2
    )
  );

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const settings = JSON.parse(await readFile(path.join(copilotDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.preToolUse, [
    {
      type: "command",
      bash: "$HOME/.copilot/hooks/keep-this-user-hook.sh",
      timeoutSec: 5,
    },
  ]);
  assert.deepEqual(settings.hooks.postToolUse, []);
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);

  await rm(home, { recursive: true, force: true });
});

test("installer normalizes duplicate direct goal hooks without removing composite user hooks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-duplicate-hooks-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(
    path.join(copilotDir, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          sessionStart: [
            {
              type: "command",
              bash: "~/.copilot/hooks/merge-hook-context.sh ~/.copilot/hooks/system-info.sh ~/.copilot/hooks/goal-context.sh",
              timeoutSec: 15,
            },
            {
              type: "command",
              bash: "$HOME/.copilot/hooks/goal-context.sh",
              timeoutSec: 5,
            },
          ],
          agentStop: [
            {
              type: "command",
              bash: "~/.copilot/hooks/goal-context.sh",
              timeoutSec: 5,
            },
            {
              type: "command",
              bash: "$HOME/.copilot/hooks/goal-context.sh",
              timeoutSec: 5,
            },
          ],
          preToolUse: [
            {
              type: "command",
              bash: "~/.copilot/hooks/safety-guard.sh",
              timeoutSec: 5,
            },
          ],
        },
      },
      null,
      2
    )
  );

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const settings = JSON.parse(await readFile(path.join(copilotDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.sessionStart, [
    {
      type: "command",
      bash: "~/.copilot/hooks/merge-hook-context.sh ~/.copilot/hooks/system-info.sh ~/.copilot/hooks/goal-context.sh",
      timeoutSec: 15,
    },
  ]);
  assert.deepEqual(settings.hooks.agentStop, [
    {
      type: "command",
      bash: "$HOME/.copilot/hooks/goal-context.sh",
      timeoutSec: 5,
    },
  ]);
  assert.deepEqual(settings.hooks.preToolUse, [
    {
      type: "command",
      bash: "~/.copilot/hooks/safety-guard.sh",
      timeoutSec: 5,
    },
  ]);

  await rm(home, { recursive: true, force: true });
});

test("installer replaces stale runtime files and avoids unchanged settings backups", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-stale-runtime-"));
  const copilotDir = path.join(home, ".copilot");

  await execFileAsync("mkdir", ["-p", path.join(copilotDir, "extensions", "goal-system", "obsolete")]);
  await writeFile(path.join(copilotDir, "extensions", "goal-system", "obsolete", "old-file.txt"), "stale");

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  await assert.rejects(
    readFile(path.join(copilotDir, "extensions", "goal-system", "obsolete", "old-file.txt"), "utf8"),
    /ENOENT/
  );

  const firstFindResult = await execFileAsync("find", [copilotDir, "-name", "settings.json.backup-*"], { encoding: "utf8" });
  const firstBackups = firstFindResult.stdout.trim().split("\n").filter(Boolean);

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const secondFindResult = await execFileAsync("find", [copilotDir, "-name", "settings.json.backup-*"], { encoding: "utf8" });
  const secondBackups = secondFindResult.stdout.trim().split("\n").filter(Boolean);
  assert.equal(secondBackups.length, firstBackups.length);

  await rm(home, { recursive: true, force: true });
});

test("installer refuses corrupt settings instead of overwriting them", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-bad-json-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(path.join(copilotDir, "settings.json"), "{bad json");

  await assert.rejects(
    execFileAsync(process.execPath, [installer], {
      cwd: root,
      env: { ...process.env, HOME: home },
      maxBuffer: 1024 * 1024 * 8,
    }),
    /not valid JSON/
  );

  assert.equal(await readFile(path.join(copilotDir, "settings.json"), "utf8"), "{bad json");
  await assert.rejects(readFile(path.join(copilotDir, "extensions", "goal-system", "package.json"), "utf8"), /ENOENT/);

  await rm(home, { recursive: true, force: true });
});

test("installer preflights corrupt VS Code MCP config before changing runtime files", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-vscode-mcp-bad-json-"));
  const copilotDir = path.join(home, ".copilot");
  const vscodeMcpConfigPath = path.join(home, "Code", "User", "mcp.json");
  await execFileAsync("mkdir", ["-p", path.dirname(vscodeMcpConfigPath), copilotDir]);
  await writeFile(vscodeMcpConfigPath, "{bad json");

  await assert.rejects(
    execFileAsync(process.execPath, [installer, "--target", "all", "--vscode-mcp-config", vscodeMcpConfigPath], {
      cwd: root,
      env: { ...process.env, HOME: home },
      maxBuffer: 1024 * 1024 * 8,
    }),
    /not valid JSON/
  );

  assert.equal(await readFile(vscodeMcpConfigPath, "utf8"), "{bad json");
  await assert.rejects(readFile(path.join(copilotDir, "extensions", "goal-system", "package.json"), "utf8"), /ENOENT/);

  await rm(home, { recursive: true, force: true });
});

test("installer treats an empty settings file as an empty settings object", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-empty-json-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(path.join(copilotDir, "settings.json"), "");

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const settings = JSON.parse(await readFile(path.join(copilotDir, "settings.json"), "utf8"));
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);

  await rm(home, { recursive: true, force: true });
});
