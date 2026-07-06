import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse as parseJsonc } from "jsonc-parser";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const installer = path.join(root, "scripts", "install.mjs");
const bootstrapInstallSh = path.join(root, "install.sh");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
process.env.GOAL_SYSTEM_TEST_LINK_NODE_MODULES = path.join(root, "node_modules");

async function buildRepoTarball(destTarballPath) {
  const { stdout } = await execFileAsync("git", ["-C", root, "ls-files"], { maxBuffer: 1024 * 1024 * 16 });
  const files = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "goal-tarball-stage-"));
  const wrapperName = "copilot-goal-system-main";
  const wrapperDir = path.join(stageDir, wrapperName);
  for (const file of files) {
    const src = path.join(root, file);
    const dest = path.join(wrapperDir, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest);
  }
  // Pre-seed the dependency scripts/install.sh checks for so the bootstrap
  // extraction does not need real npm registry access to run the installer.
  await cp(path.join(root, "node_modules", "jsonc-parser"), path.join(wrapperDir, "node_modules", "jsonc-parser"), { recursive: true });
  await execFileAsync("tar", ["-czf", destTarballPath, "-C", stageDir, wrapperName]);
  await rm(stageDir, { recursive: true, force: true });
}

async function runPipedInstall(env) {
  const scriptContent = await readFile(bootstrapInstallSh, "utf8");
  const promise = execFileAsync("bash", [], { env, maxBuffer: 1024 * 1024 * 16 });
  promise.child.stdin.write(scriptContent);
  promise.child.stdin.end();
  return promise;
}

async function readJsonc(filePath) {
  return parseJsonc(await readFile(filePath, "utf8"));
}

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

test("piped install.sh (curl | bash) bootstraps from a downloaded archive", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-bootstrap-"));
  const tarballDir = await mkdtemp(path.join(os.tmpdir(), "goal-install-bootstrap-tarball-"));
  const tarballPath = path.join(tarballDir, "copilot-goal-system.tar.gz");

  try {
    await buildRepoTarball(tarballPath);

    const env = {
      ...process.env,
      HOME: home,
      GOAL_SYSTEM_INSTALL_SOURCE_URL: `file://${tarballPath}`,
      GOAL_SYSTEM_TEST_LINK_NODE_MODULES: path.join(root, "node_modules"),
    };

    const { stdout } = await runPipedInstall(env);
    assert.match(stdout, /Installed Copilot Goal System/);

    const copilotDir = path.join(home, ".copilot");
    assert.equal(await exists(path.join(copilotDir, "extensions", "goal-system")), true);
    assert.equal(await exists(path.join(copilotDir, "skills", "goal", "SKILL.md")), true);
    assert.equal(await exists(path.join(copilotDir, "hooks", "goal-context.sh")), true);
    assert.equal(await exists(path.join(copilotDir, "extensions", "goal-system", "bin", "goalctl.mjs")), true);

    const installedPackage = JSON.parse(await readFile(path.join(copilotDir, "extensions", "goal-system", "package.json"), "utf8"));
    assert.equal(installedPackage.version, rootPackage.version);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(tarballDir, { recursive: true, force: true });
  }
});

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

test("installer merges hooks, writes backups, and preserves existing settings", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-test-"));
  const copilotDir = path.join(home, ".copilot");
  const settingsPath = path.join(copilotDir, "settings.json");
  await writeFile(
    settingsPath,
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
      settingsPath,
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
  await chmod(settingsPath, 0o600);

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
  assert.equal(settings.hooks.preToolUse.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);
  assert.equal(settings.hooks.postToolUse.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);

  assert.equal(await readFile(path.join(copilotDir, "extensions", "goal-system", "bin", "goalctl.mjs"), "utf8").then((text) => text.startsWith("#!/usr/bin/env node")), true);

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
  const backupPaths = findResult.stdout.trim().split("\n").filter((filePath) => /settings\.json\.backup-/.test(filePath));
  assert.equal(backupPaths.length, 1);
  assert.equal((await stat(backupPaths[0])).mode & 0o777, 0o600);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);

  await rm(home, { recursive: true, force: true });
});

test("installer accepts JSONC settings without stripping comments", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-jsonc-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(
    path.join(copilotDir, "settings.json"),
    `{
  // Copilot CLI settings are JSONC.
  "theme": "auto",
  "hooks": {
    "sessionStart": [
      { "type": "command", "bash": "$HOME/.copilot/hooks/existing.sh", "timeoutSec": 1 },
    ],
  },
}
`
  );

  await execFileAsync(process.execPath, [installer, "--target", "all"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  const settingsRaw = await readFile(path.join(copilotDir, "settings.json"), "utf8");
  assert.match(settingsRaw, /Copilot CLI settings are JSONC/);
  const settings = parseJsonc(settingsRaw);
  assert.equal(settings.theme, "auto");
  assert.equal(settings.hooks.sessionStart.some((hook) => hook.bash === "$HOME/.copilot/hooks/existing.sh"), true);
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);

  const findResult = await execFileAsync("find", [home, "-name", "*.backup-*"], { encoding: "utf8" });
  assert.match(findResult.stdout, /settings\.json\.backup-/);

  await rm(home, { recursive: true, force: true });
});

test("installer writes a Copilot CLI MCP server config for the MCP target", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-mcp-"));
  const copilotDir = path.join(home, ".copilot");

  await execFileAsync(process.execPath, [installer, "--target", "mcp"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const mcpConfigPath = path.join(copilotDir, "mcp-config.json");
  const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.deepEqual(mcpConfig.mcpServers.goalSystem, {
    type: "local",
    command: "node",
    args: [path.join(copilotDir, "extensions", "goal-system", "adapters", "mcp", "server.mjs")],
    env: {
      COPILOT_HOME: copilotDir,
    },
    tools: ["*"],
  });
  assert.equal((await stat(mcpConfigPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(copilotDir, "extensions", "goal-system", "adapters", "mcp", "server.mjs"))).mode & 0o777, 0o755);
  await assert.rejects(readFile(path.join(copilotDir, "settings.json"), "utf8"), /ENOENT/);

  await rm(home, { recursive: true, force: true });
});

test("installer preserves MCP config entries and repairs malformed MCP config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-mcp-repair-"));
  const copilotDir = path.join(home, ".copilot");
  const mcpConfigPath = path.join(copilotDir, "mcp-config.json");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(mcpConfigPath, "{bad json");
  await chmod(mcpConfigPath, 0o600);

  const { stderr } = await execFileAsync(process.execPath, [installer, "--target", "mcp"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  assert.match(stderr, /could not be used as Copilot CLI MCP config/);
  const backups = await execFileAsync("find", [copilotDir, "-name", "mcp-config.json.invalid-backup-*"], { encoding: "utf8" });
  const backupPaths = backups.stdout.trim().split("\n").filter(Boolean);
  assert.equal(backupPaths.length, 1);
  assert.equal(await readFile(backupPaths[0], "utf8"), "{bad json");

  const repaired = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(repaired.mcpServers.goalSystem.command, "node");
  assert.equal(repaired.mcpServers.goalSystem.tools[0], "*");
  assert.equal((await stat(mcpConfigPath)).mode & 0o777, 0o600);

  await writeFile(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          existingServer: {
            type: "http",
            url: "https://example.test/mcp",
            tools: ["*"],
          },
        },
      },
      null,
      2
    )
  );

  await execFileAsync(process.execPath, [installer, "--target", "all"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 12,
  });

  const merged = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(merged.mcpServers.existingServer.url, "https://example.test/mcp");
  assert.equal(merged.mcpServers.goalSystem.args[0], path.join(copilotDir, "extensions", "goal-system", "adapters", "mcp", "server.mjs"));

  await rm(home, { recursive: true, force: true });
});

test("installer normalizes CLI tool-use hooks while preserving user hooks", async () => {
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

  const settings = await readJsonc(path.join(copilotDir, "settings.json"));
  assert.deepEqual(settings.hooks.preToolUse, [
    {
      type: "command",
      bash: "$HOME/.copilot/hooks/keep-this-user-hook.sh",
      timeoutSec: 5,
    },
    {
      type: "command",
      bash: "$HOME/.copilot/hooks/goal-context.sh",
      timeoutSec: 5,
    },
  ]);
  assert.deepEqual(settings.hooks.postToolUse, [
    {
      type: "command",
      bash: "$HOME/.copilot/hooks/goal-context.sh",
      timeoutSec: 5,
    },
  ]);
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
    {
      type: "command",
      bash: "$HOME/.copilot/hooks/goal-context.sh",
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

test("installer keeps existing runtime when dependency install fails during update", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-failed-update-"));
  const copilotDir = path.join(home, ".copilot");
  const extensionDir = path.join(copilotDir, "extensions", "goal-system");
  const fakeBin = path.join(home, "bin");
  await mkdir(extensionDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(extensionDir, "package.json"), `${JSON.stringify({ name: "goal-system", version: "0.0.1" }, null, 2)}\n`);
  await writeFile(path.join(extensionDir, "old-runtime-marker.txt"), "still here");
  const fakeNpm = path.join(fakeBin, "npm");
  await writeFile(fakeNpm, "#!/usr/bin/env bash\necho 'simulated npm failure' >&2\nexit 1\n");
  await chmod(fakeNpm, 0o755);

  await assertCommandFails(
    execFileAsync(process.execPath, [installer], {
      cwd: root,
      env: { ...process.env, GOAL_SYSTEM_TEST_LINK_NODE_MODULES: "", HOME: home, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      maxBuffer: 1024 * 1024 * 8,
    }),
    /npm ci failed/
  );

  const installedPackage = JSON.parse(await readFile(path.join(extensionDir, "package.json"), "utf8"));
  assert.equal(installedPackage.version, "0.0.1");
  assert.equal(await readFile(path.join(extensionDir, "old-runtime-marker.txt"), "utf8"), "still here");
  await assert.rejects(readFile(path.join(copilotDir, "settings.json"), "utf8"), /ENOENT/);
  const leftovers = await execFileAsync("find", [path.join(copilotDir, "extensions"), "-maxdepth", "1", "-name", ".goal-system-*"], { encoding: "utf8" });
  assert.equal(leftovers.stdout.trim(), "");

  await rm(home, { recursive: true, force: true });
});

test("installer leaves malformed config untouched when dependency install fails during update", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-failed-update-bad-config-"));
  const copilotDir = path.join(home, ".copilot");
  const extensionDir = path.join(copilotDir, "extensions", "goal-system");
  const fakeBin = path.join(home, "bin");
  await mkdir(extensionDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(extensionDir, "package.json"), `${JSON.stringify({ name: "goal-system", version: "0.0.1" }, null, 2)}\n`);
  await writeFile(path.join(extensionDir, "old-runtime-marker.txt"), "still here");
  await writeFile(path.join(copilotDir, "settings.json"), "{bad json");
  const fakeNpm = path.join(fakeBin, "npm");
  await writeFile(fakeNpm, "#!/usr/bin/env bash\necho 'simulated npm failure' >&2\nexit 1\n");
  await chmod(fakeNpm, 0o755);

  await assertCommandFails(
    execFileAsync(process.execPath, [installer], {
      cwd: root,
      env: { ...process.env, GOAL_SYSTEM_TEST_LINK_NODE_MODULES: "", HOME: home, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      maxBuffer: 1024 * 1024 * 8,
    }),
    /npm ci failed/
  );

  const installedPackage = JSON.parse(await readFile(path.join(extensionDir, "package.json"), "utf8"));
  assert.equal(installedPackage.version, "0.0.1");
  assert.equal(await readFile(path.join(extensionDir, "old-runtime-marker.txt"), "utf8"), "still here");
  assert.equal(await readFile(path.join(copilotDir, "settings.json"), "utf8"), "{bad json");
  const backups = await execFileAsync("find", [copilotDir, "-name", "settings.json.invalid-backup-*"], { encoding: "utf8" });
  assert.equal(backups.stdout.trim(), "");

  await rm(home, { recursive: true, force: true });
});

test("installer recovers non-object config before replacing existing runtime", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-non-object-config-"));
  const copilotDir = path.join(home, ".copilot");
  const extensionDir = path.join(copilotDir, "extensions", "goal-system");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, "package.json"), `${JSON.stringify({ name: "goal-system", version: "0.0.1" }, null, 2)}\n`);
  await writeFile(path.join(extensionDir, "old-runtime-marker.txt"), "still here");
  await writeFile(path.join(copilotDir, "settings.json"), "[]\n");

  const { stderr } = await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const installedPackage = JSON.parse(await readFile(path.join(extensionDir, "package.json"), "utf8"));
  assert.equal(installedPackage.version, rootPackage.version);
  await assert.rejects(readFile(path.join(extensionDir, "old-runtime-marker.txt"), "utf8"), /ENOENT/);
  assert.match(stderr, /the file must contain a JSON object/);
  const backups = await execFileAsync("find", [copilotDir, "-name", "settings.json.invalid-backup-*"], { encoding: "utf8" });
  const backupPaths = backups.stdout.trim().split("\n").filter(Boolean);
  assert.equal(backupPaths.length, 1);
  assert.equal(await readFile(backupPaths[0], "utf8"), "[]\n");
  const settings = JSON.parse(await readFile(path.join(copilotDir, "settings.json"), "utf8"));
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);

  await rm(home, { recursive: true, force: true });
});

test("installer copies only the runtime bundle allowlist into the installed runtime", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-allowlist-"));

  await execFileAsync(process.execPath, [installer, "--target", "cli"], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  await assert.rejects(readFile(path.join(home, ".copilot", "extensions", "goal-system", "app-session-O7kcZj7R.js"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(home, ".copilot", "extensions", "goal-system", "main-BwqrdVu3.js"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(home, ".copilot", "extensions", "goal-system", "dist", `copilot-goal-system-${rootPackage.version}.vsix`), "utf8"), /ENOENT/);
  assert.equal((await stat(path.join(home, ".copilot", "settings.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(home, ".copilot", "extensions", "goal-system", "bin", "goalctl.mjs"))).mode & 0o777, 0o755);

  await rm(home, { recursive: true, force: true });
});

test("installer honors COPILOT_HOME for non-default Copilot profiles", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-copilot-home-"));
  const copilotHome = path.join(home, "custom-copilot-profile");

  await execFileAsync(process.execPath, [installer, "--target", "cli"], {
    cwd: root,
    env: { ...process.env, HOME: home, COPILOT_HOME: copilotHome },
    maxBuffer: 1024 * 1024 * 8,
  });

  const installedPackage = JSON.parse(await readFile(path.join(copilotHome, "extensions", "goal-system", "package.json"), "utf8"));
  assert.equal(installedPackage.version, rootPackage.version);
  const settings = await readJsonc(path.join(copilotHome, "settings.json"));
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$COPILOT_HOME/hooks/goal-context.sh"), true);
  assert.equal((await stat(path.join(copilotHome, "extensions", "goal-system", "bin", "goalctl.mjs"))).mode & 0o777, 0o755);
  await assert.rejects(readFile(path.join(home, ".copilot", "settings.json"), "utf8"), /ENOENT/);

  await rm(home, { recursive: true, force: true });
});

test("installer recovers corrupt settings by preserving an invalid backup", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-bad-json-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(path.join(copilotDir, "settings.json"), "{bad json");
  await chmod(path.join(copilotDir, "settings.json"), 0o600);

  const { stderr } = await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  assert.match(stderr, /could not be used as Copilot CLI settings/);
  const backups = await execFileAsync("find", [copilotDir, "-name", "settings.json.invalid-backup-*"], { encoding: "utf8" });
  const backupPaths = backups.stdout.trim().split("\n").filter(Boolean);
  assert.equal(backupPaths.length, 1);
  assert.equal(await readFile(backupPaths[0], "utf8"), "{bad json");
  assert.equal((await stat(backupPaths[0])).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(copilotDir, "settings.json"))).mode & 0o777, 0o600);
  const settings = JSON.parse(await readFile(path.join(copilotDir, "settings.json"), "utf8"));
  assert.equal(settings.hooks.agentStop.some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"), true);
  const installedPackage = JSON.parse(await readFile(path.join(copilotDir, "extensions", "goal-system", "package.json"), "utf8"));
  assert.equal(installedPackage.version, rootPackage.version);

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

test("installer replaces an array-typed settings.hooks value instead of silently installing zero hooks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-array-hooks-"));
  const copilotDir = path.join(home, ".copilot");
  await execFileAsync("mkdir", ["-p", copilotDir]);
  await writeFile(
    path.join(copilotDir, "settings.json"),
    JSON.stringify(
      {
        theme: "auto",
        hooks: [],
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
  assert.equal(settings.theme, "auto");
  assert.equal(Array.isArray(settings.hooks), false);

  const expectedEvents = [
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
  for (const eventName of expectedEvents) {
    assert.equal(
      Array.isArray(settings.hooks[eventName]) && settings.hooks[eventName].some((hook) => hook.bash === "$HOME/.copilot/hooks/goal-context.sh"),
      true,
      `expected goal-context hook for ${eventName}`
    );
  }

  await rm(home, { recursive: true, force: true });
});

test("installer restores the shipped copilot-instructions snippet when the installed body has drifted", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-snippet-drift-"));
  const copilotDir = path.join(home, ".copilot");
  const instructionsPath = path.join(copilotDir, "copilot-instructions.md");
  const shippedSnippet = (await readFile(path.join(root, "instructions", "copilot-instructions.goal-snippet.md"), "utf8")).trim();

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const original = await readFile(instructionsPath, "utf8");
  const mutated = original.replace("goal_system_*", "MUTATED_SNIPPET_BODY");
  assert.notEqual(mutated, original);
  await writeFile(instructionsPath, mutated);

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const restored = await readFile(instructionsPath, "utf8");
  assert.doesNotMatch(restored, /MUTATED_SNIPPET_BODY/);
  const restoredBetweenMarkers = restored
    .slice(restored.indexOf("<!-- copilot-goal-system snippet start -->") + "<!-- copilot-goal-system snippet start -->".length, restored.indexOf("<!-- copilot-goal-system snippet end -->"))
    .trim();
  assert.equal(restoredBetweenMarkers, shippedSnippet);

  const backups = await execFileAsync("find", [copilotDir, "-name", "copilot-instructions.md.backup-*"], { encoding: "utf8" });
  assert.equal(backups.stdout.trim().split("\n").filter(Boolean).length, 1);

  await rm(home, { recursive: true, force: true });
});

test("installer leaves copilot-instructions.md untouched when the installed snippet already matches", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-install-snippet-stable-"));
  const copilotDir = path.join(home, ".copilot");
  const instructionsPath = path.join(copilotDir, "copilot-instructions.md");

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const beforeContent = await readFile(instructionsPath, "utf8");
  const beforeMtimeMs = (await stat(instructionsPath)).mtimeMs;

  await execFileAsync(process.execPath, [installer], {
    cwd: root,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024 * 8,
  });

  const afterContent = await readFile(instructionsPath, "utf8");
  const afterMtimeMs = (await stat(instructionsPath)).mtimeMs;
  assert.equal(afterContent, beforeContent);
  assert.equal(afterMtimeMs, beforeMtimeMs);

  const backups = await execFileAsync("find", [copilotDir, "-name", "copilot-instructions.md.backup-*"], { encoding: "utf8" });
  assert.equal(backups.stdout.trim(), "");

  await rm(home, { recursive: true, force: true });
});
