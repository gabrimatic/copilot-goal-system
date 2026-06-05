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

test("doctor reports a healthy all-target local install", async () => {
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
  assert.equal(report.checks.find((item) => item.label === "MCP server config").ok, true);
  assert.equal(report.checks.find((item) => item.label === "MCP server self-test").ok, true);
  assert.equal(report.checks.find((item) => item.label === "All CLI lifecycle hooks").ok, true);
  assert.equal(report.checks.find((item) => item.label === "No stale wrapped drift hooks").ok, true);

  const installedDoctor = path.join(home, ".copilot", "extensions", "goal-system", "scripts", "doctor.mjs");
  const installedDoctorResult = await execFileAsync(process.execPath, [installedDoctor, "--home", home, "--target", "all", "--json"], {
    cwd: path.dirname(path.dirname(installedDoctor)),
    env,
    maxBuffer: 1024 * 1024 * 4,
  });
  assert.equal(JSON.parse(installedDoctorResult.stdout).ok, true);

  await rm(home, { recursive: true, force: true });
});

test("doctor can scope health checks to MCP-only installs", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "goal-doctor-mcp-"));
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin, { recursive: true });

  const env = isolatedEnv(home, fakeBin);
  await execFileAsync(process.execPath, [installer, "--target", "mcp"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 8,
  });

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--target", "mcp", "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.target, "mcp");
  assert.equal(report.checks.find((item) => item.label === "MCP server config").ok, true);
  assert.equal(report.checks.find((item) => item.label === "MCP server self-test").ok, true);
  assert.equal(report.checks.some((item) => item.label === "Copilot CLI command"), false);
  assert.equal(report.checks.some((item) => item.label === "VS Code Chat custom agent"), false);

  await rm(home, { recursive: true, force: true });
});

test("doctor accepts JSONC settings after install", async () => {
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
  await writeFile(settingsPath, withTopLevelJsoncComment(await readFile(settingsPath, "utf8"), "settings remain valid JSONC"));

  const { stdout } = await execFileAsync(process.execPath, [doctor, "--home", home, "--target", "all", "--json"], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024 * 4,
  });

  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((item) => item.label === "CLI settings JSON").ok, true);

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
  assert.equal(report.checks.some((item) => item.label === "VS Code Chat custom agent"), false);

  await rm(home, { recursive: true, force: true });
});
