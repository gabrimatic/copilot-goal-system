import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const installer = path.join(root, "scripts", "install.mjs");
const doctor = path.join(root, "scripts", "doctor.mjs");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
process.env.GOAL_SYSTEM_TEST_LINK_NODE_MODULES = path.join(root, "node_modules");

function withTopLevelJsoncComment(raw, comment) {
  return raw.replace("{", `{\n  // ${comment}`).replace(/\n}\s*$/, ",\n}\n");
}

function defaultVscodeMcpConfigPath(home) {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

test("doctor reports a healthy all-target install with CLI MCP fallback", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH || ""}` };
  await execFileAsync(process.execPath, [installer, "--target", "all"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--target", "all", "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.target, "all");
  assert.equal(report.checks.find((item) => item.label === "Copilot CLI MCP goal server").ok, true);
  assert.equal(report.checks.find((item) => item.label === "Configured CLI MCP self-test").ok, true);
  assert.equal(report.checks.find((item) => item.label === "Copilot CLI loads goalSystem MCP").ok, true);
  assert.equal(report.checks.find((item) => item.label === "VS Code MCP goal server").ok, true);
  assert.equal(report.checks.find((item) => item.label === "Configured VS Code MCP self-test").ok, true);

  const installedDoctor = path.join(home, ".copilot", "extensions", "goal-system", "scripts", "doctor.mjs");
  const installedDoctorResult = await execFileAsync(process.execPath, [installedDoctor, "--home", home, "--target", "all", "--json"], {
    cwd: path.dirname(path.dirname(installedDoctor)),
    env,
    maxBuffer: 1024 * 1024 * 4,
  });
  assert.equal(JSON.parse(installedDoctorResult.stdout).ok, true);

  const cliMcpConfig = JSON.parse(await readFile(path.join(home, ".copilot", "mcp-config.json"), "utf8"));
  assert.equal(cliMcpConfig.mcpServers.goalSystem.type, "local");

  await rm(home, { recursive: true, force: true });
});

test("doctor accepts JSONC Copilot and VS Code config files", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-jsonc-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH || ""}` };
  await execFileAsync(process.execPath, [installer, "--target", "all"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const settingsPath = path.join(home, ".copilot", "settings.json");
  const cliMcpConfigPath = path.join(home, ".copilot", "mcp-config.json");
  const vscodeMcpConfigPath = defaultVscodeMcpConfigPath(home);
  await writeFile(settingsPath, withTopLevelJsoncComment(await readFile(settingsPath, "utf8"), "settings remain valid JSONC"));
  await writeFile(cliMcpConfigPath, withTopLevelJsoncComment(await readFile(cliMcpConfigPath, "utf8"), "CLI MCP remains valid JSONC"));
  await writeFile(vscodeMcpConfigPath, withTopLevelJsoncComment(await readFile(vscodeMcpConfigPath, "utf8"), "VS Code MCP remains valid JSONC"));

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--target", "all", "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((item) => item.label === "CLI settings JSON").ok, true);
  assert.equal(report.checks.find((item) => item.label === "Copilot CLI MCP goal server").ok, true);
  assert.equal(report.checks.find((item) => item.label === "VS Code MCP goal server").ok, true);

  await rm(home, { recursive: true, force: true });
});

test("doctor honors explicit VS Code MCP config paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-vscode-path-"));
  const fakeBin = path.join(home, "bin");
  const vscodeMcpConfigPath = path.join(home, "custom-vscode", "mcp.json");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH || ""}` };
  await execFileAsync(process.execPath, [installer, "--target", "all", "--vscode-mcp-config", vscodeMcpConfigPath], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--target", "all", "--vscode-mcp-config", vscodeMcpConfigPath, "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.paths.vscodeMcpConfigPath, vscodeMcpConfigPath);
  assert.equal(report.checks.find((item) => item.label === "VS Code MCP goal server").ok, true);

  await rm(home, { recursive: true, force: true });
});

test("doctor honors COPILOT_HOME for non-default Copilot profiles", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-copilot-home-"));
  const copilotHome = path.join(home, "custom-copilot-profile");
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = { ...process.env, HOME: home, COPILOT_HOME: copilotHome, PATH: `${fakeBin}:${process.env.PATH || ""}` };
  await execFileAsync(process.execPath, [installer, "--target", "cli"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--target", "cli", "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.paths.copilotRoot, copilotHome);
  assert.equal(report.paths.settingsPath, path.join(copilotHome, "settings.json"));
  assert.equal(report.checks.find((item) => item.label === "Installed runtime package").details, rootPackage.version);

  await rm(home, { recursive: true, force: true });
});

test("doctor can scope health checks to CLI-only installs", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-cli-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH || ""}` };
  await execFileAsync(process.execPath, [installer, "--target", "cli"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.target, "cli");
  assert.equal(report.checks.some((item) => item.label === "VS Code MCP goal server"), false);

  await rm(home, { recursive: true, force: true });
});

test("doctor fails stale CLI MCP config paths instead of self-testing the expected path", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-stale-mcp-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH || ""}` };
  await execFileAsync(process.execPath, [installer, "--target", "cli"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const mcpConfigPath = path.join(home, ".copilot", "mcp-config.json");
  const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  mcpConfig.mcpServers.goalSystem.args = ["/tmp/dead/mcp-server.mjs"];
  await writeFile(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(process.execPath, [doctor, "--home", home, "--json"], {
      cwd: root,
      env,
      maxBuffer: 1024 * 1024 * 4,
    }),
    (error) => {
      const report = JSON.parse(error.stdout);
      const mcpCheck = report.checks.find((item) => item.label === "Copilot CLI MCP goal server");
      const selfTest = report.checks.find((item) => item.label === "Configured CLI MCP self-test");
      assert.equal(mcpCheck.ok, false);
      assert.match(mcpCheck.details, /\/tmp\/dead\/mcp-server\.mjs/);
      assert.equal(selfTest.ok, false);
      return true;
    }
  );

  await rm(home, { recursive: true, force: true });
});
