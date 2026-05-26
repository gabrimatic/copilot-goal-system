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

function isolatedEnv(home, fakeBin, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    ...extra,
  };
}

test("doctor reports a healthy all-target no-MCP install", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = isolatedEnv(home, fakeBin);
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
  assert.equal(report.checks.find((item) => item.label === "Local goalctl command").ok, true);
  assert.equal(report.checks.find((item) => item.label === "goalctl self-test").ok, true);
  assert.equal(report.checks.find((item) => item.label === "No legacy CLI goalSystem server").ok, true);
  assert.equal(report.checks.find((item) => item.label === "No legacy VS Code goalSystem server").ok, true);

  const installedDoctor = path.join(home, ".copilot", "extensions", "goal-system", "scripts", "doctor.mjs");
  const installedDoctorResult = await execFileAsync(process.execPath, [installedDoctor, "--home", home, "--target", "all", "--json"], {
    cwd: path.dirname(path.dirname(installedDoctor)),
    env,
    maxBuffer: 1024 * 1024 * 4,
  });
  assert.equal(JSON.parse(installedDoctorResult.stdout).ok, true);

  await assert.rejects(readFile(path.join(home, ".copilot", "mcp-config.json"), "utf8"), /ENOENT/);

  await rm(home, { recursive: true, force: true });
});

test("doctor accepts JSONC settings and legacy server config files without goalSystem entries", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-jsonc-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = isolatedEnv(home, fakeBin);
  await execFileAsync(process.execPath, [installer, "--target", "all"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const settingsPath = path.join(home, ".copilot", "settings.json");
  const cliMcpConfigPath = path.join(home, ".copilot", "mcp-config.json");
  const vscodeMcpConfigPath = defaultVscodeMcpConfigPath(home);
  await mkdir(path.dirname(vscodeMcpConfigPath), { recursive: true });
  await writeFile(settingsPath, withTopLevelJsoncComment(await readFile(settingsPath, "utf8"), "settings remain valid JSONC"));
  await writeFile(
    cliMcpConfigPath,
    `{
  // CLI server config remains valid JSONC.
  "mcpServers": {
    "playwright": { "type": "stdio", "command": "npx" },
  },
}
`
  );
  await writeFile(
    vscodeMcpConfigPath,
    `{
  // VS Code server config remains valid JSONC.
  "servers": {
    "existingServer": { "type": "stdio", "command": "node" },
  },
}
`
  );

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--target", "all", "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((item) => item.label === "CLI settings JSON").ok, true);
  assert.equal(report.checks.find((item) => item.label === "No legacy CLI goalSystem server").ok, true);
  assert.equal(report.checks.find((item) => item.label === "No legacy VS Code goalSystem server").ok, true);

  await rm(home, { recursive: true, force: true });
});

test("doctor honors explicit legacy VS Code server cleanup paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-vscode-path-"));
  const fakeBin = path.join(home, "bin");
  const vscodeMcpConfigPath = path.join(home, "custom-vscode", "mcp.json");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(path.dirname(vscodeMcpConfigPath), { recursive: true });
  await writeFile(
    vscodeMcpConfigPath,
    JSON.stringify({ servers: { goalSystem: { type: "stdio", command: "node", args: ["/tmp/old/mcp-server.mjs"] } } }, null, 2)
  );
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = isolatedEnv(home, fakeBin);
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
  assert.equal(report.paths.legacyVscodeConfigPath, vscodeMcpConfigPath);
  assert.equal(report.checks.find((item) => item.label === "No legacy VS Code goalSystem server").ok, true);
  const config = JSON.parse(await readFile(vscodeMcpConfigPath, "utf8"));
  assert.equal(config.servers.goalSystem, undefined);

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

  const env = isolatedEnv(home, fakeBin, { COPILOT_HOME: copilotHome });
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

  const env = isolatedEnv(home, fakeBin);
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
  assert.equal(report.checks.some((item) => item.label === "No legacy VS Code goalSystem server"), false);

  await rm(home, { recursive: true, force: true });
});

test("doctor fails when a legacy CLI goalSystem server entry remains", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-legacy-server-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCopilot = path.join(fakeBin, "copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env bash\nprintf 'GitHub Copilot CLI 1.0.45.\\n'\n");
  await chmod(fakeCopilot, 0o755);

  const env = isolatedEnv(home, fakeBin);
  await execFileAsync(process.execPath, [installer, "--target", "cli"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 12,
  });

  const mcpConfigPath = path.join(home, ".copilot", "mcp-config.json");
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify({ mcpServers: { goalSystem: { type: "stdio", command: "node", args: ["/tmp/dead/mcp-server.mjs"] } } }, null, 2)}\n`
  );

  await assert.rejects(
    execFileAsync(process.execPath, [doctor, "--home", home, "--json"], {
      cwd: root,
      env,
      maxBuffer: 1024 * 1024 * 4,
    }),
    (error) => {
      const report = JSON.parse(error.stdout);
      const legacyCheck = report.checks.find((item) => item.label === "No legacy CLI goalSystem server");
      assert.equal(legacyCheck.ok, false);
      assert.match(legacyCheck.details, /mcp-config\.json/);
      return true;
    }
  );

  await rm(home, { recursive: true, force: true });
});
