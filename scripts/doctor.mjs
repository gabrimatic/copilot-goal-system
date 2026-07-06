#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  countDuplicateGoalHooks,
  findStaleDriftHookEvents,
  hookInstalled,
} = require("../lib/install-status.cjs");
const { parseJsoncText } = require("../lib/jsonc-file.cjs");
const { copilotRootForHome } = require("../lib/copilot-paths.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const CLI_HOOK_EVENTS = [
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

function parseArgs(argv) {
  const options = {
    home: process.env.HOME || os.homedir(),
    cwd: process.cwd(),
    target: "cli",
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--home") {
      options.home = argv[index + 1] || options.home;
      index += 1;
    } else if (arg.startsWith("--home=")) {
      options.home = arg.slice("--home=".length);
    } else if (arg === "--cwd") {
      options.cwd = argv[index + 1] || options.cwd;
      index += 1;
    } else if (arg.startsWith("--cwd=")) {
      options.cwd = arg.slice("--cwd=".length);
    } else if (arg === "--target") {
      options.target = argv[index + 1] || options.target;
      index += 1;
    } else if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    }
  }
  if (!["cli", "vscode-chat", "mcp", "all"].includes(options.target)) {
    throw new Error(`Unknown --target "${options.target}". Use cli, vscode-chat, mcp, or all.`);
  }
  options.home = path.resolve(options.home);
  options.cwd = path.resolve(options.cwd);
  return options;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return { value: parseJsoncText(raw, filePath), exists: true };
  } catch (error) {
    if (error.code === "ENOENT") return { value: null, exists: false };
    return { value: null, exists: true, error: error.message || String(error) };
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

function check(label, ok, details = "", remediation = "", info = false) {
  return {
    label,
    ok: Boolean(ok),
    details,
    remediation,
    info: Boolean(info),
  };
}

async function sameFilesystemPath(left, right) {
  const [leftReal, rightReal] = await Promise.all([
    realpath(left).catch(() => path.resolve(left)),
    realpath(right).catch(() => path.resolve(right)),
  ]);
  return leftReal === rightReal;
}

function profileEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: copilotRootForHome(home) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const copilotRoot = copilotRootForHome(options.home);
  const extensionDir = path.join(copilotRoot, "extensions", "goal-system");
  const settingsPath = path.join(copilotRoot, "settings.json");
  const mcpConfigPath = path.join(copilotRoot, "mcp-config.json");
  const goalctlPath = path.join(extensionDir, "bin", "goalctl.mjs");
  const mcpServerPath = path.join(extensionDir, "adapters", "mcp", "server.mjs");

  const settings = await readJsonIfExists(settingsPath);
  const mcpConfig = await readJsonIfExists(mcpConfigPath);
  const installedPackage = await readJsonIfExists(path.join(extensionDir, "package.json"));
  const runningFromInstalledRuntime = await sameFilesystemPath(root, extensionDir);
  function installedRuntimePackageCheck(remediation) {
    if (runningFromInstalledRuntime) {
      return check(
        "Installed runtime package",
        true,
        "running from installed runtime; version sync check skipped",
        "",
        true
      );
    }
    return check(
      "Installed runtime package",
      installedPackage.value?.version === packageJson.version,
      installedPackage.value?.version || "missing",
      remediation
    );
  }
  const copilotVersion = run("copilot", ["--version"], { env: profileEnv(options.home) });
  const jqVersion = run("jq", ["--version"], { env: profileEnv(options.home) });
  const goalctlSelfTest = run(process.execPath, [goalctlPath, "--self-test"], { env: profileEnv(options.home) });
  const mcpServerSelfTest = run(process.execPath, [mcpServerPath, "--self-test"], { env: profileEnv(options.home) });

  const cliHookEventsPresent = settings.value ? CLI_HOOK_EVENTS.filter((eventName) => hookInstalled(settings.value, eventName)) : [];
  const duplicateCliGoalHooks = settings.value ? countDuplicateGoalHooks(settings.value, CLI_HOOK_EVENTS) : {};
  const staleCliDriftHookEvents = settings.value ? findStaleDriftHookEvents(settings.value) : [];
  const configuredMcpServer = mcpConfig.value?.mcpServers?.goalSystem;
  const mcpServerConfigured = Boolean(
    configuredMcpServer &&
      (configuredMcpServer.type === "local" || configuredMcpServer.type === "stdio") &&
      configuredMcpServer.command === "node" &&
      Array.isArray(configuredMcpServer.args) &&
      configuredMcpServer.args[0] === mcpServerPath &&
      Array.isArray(configuredMcpServer.tools) &&
      configuredMcpServer.tools.includes("*")
  );
  const cliChecks = [
    check("Copilot CLI command", copilotVersion.ok, copilotVersion.stdout || copilotVersion.stderr || copilotVersion.error, "Install or repair GitHub Copilot CLI."),
    installedRuntimePackageCheck("Run ./install.sh --target cli."),
    check("Local goalctl command", await exists(goalctlPath), goalctlPath, "Run ./install.sh --target cli."),
    check("goalctl self-test", goalctlSelfTest.ok, goalctlSelfTest.stdout || goalctlSelfTest.stderr || goalctlSelfTest.error, "Run ./install.sh --target cli."),
    check("Goal skill file", await exists(path.join(copilotRoot, "skills", "goal", "SKILL.md")), path.join(copilotRoot, "skills", "goal", "SKILL.md"), "Run ./install.sh --target cli."),
    check("CLI hook helper", await exists(path.join(copilotRoot, "hooks", "goal-context.sh")), path.join(copilotRoot, "hooks", "goal-context.sh"), "Run ./install.sh --target cli."),
    check("CLI hook parser dependency", jqVersion.ok, jqVersion.stdout || jqVersion.stderr || jqVersion.error || "jq unavailable", "Install jq, then restart Copilot CLI."),
    check("CLI settings JSON", settings.exists && !settings.error, settings.error || settingsPath, "Fix malformed settings.json before reinstalling."),
    check("CLI hooks enabled", settings.value && settings.value.disableAllHooks !== true, settings.value?.disableAllHooks === true ? "disableAllHooks=true" : "disableAllHooks=false", "Set disableAllHooks to false or remove it, then restart Copilot CLI."),
    check("All CLI lifecycle hooks", cliHookEventsPresent.length === CLI_HOOK_EVENTS.length, `${cliHookEventsPresent.length}/${CLI_HOOK_EVENTS.length}`, "Run ./install.sh --target cli, then restart Copilot CLI."),
    check("No duplicate CLI goal hooks", Object.keys(duplicateCliGoalHooks).length === 0, JSON.stringify(duplicateCliGoalHooks), "Run ./install.sh --target cli to normalize direct duplicates."),
    check("No stale wrapped drift hooks", staleCliDriftHookEvents.length === 0, staleCliDriftHookEvents.join(", ") || "none", "Run ./install.sh --target cli to normalize goal hook entries."),
  ];
  const vscodeChecks = [
    installedRuntimePackageCheck("Run ./install.sh --target all."),
    check("Local goalctl command", await exists(goalctlPath), goalctlPath, "Run ./install.sh --target vscode-chat."),
    check("goalctl self-test", goalctlSelfTest.ok, goalctlSelfTest.stdout || goalctlSelfTest.stderr || goalctlSelfTest.error, "Run ./install.sh --target vscode-chat."),
    check("VS Code Chat custom agent", await exists(path.join(copilotRoot, "agents", "goal-system.agent.md")), path.join(copilotRoot, "agents", "goal-system.agent.md"), "Run ./install.sh --target vscode-chat."),
    check("VS Code Chat hook config", await exists(path.join(copilotRoot, "hooks", "goal-system-vscode.json")), path.join(copilotRoot, "hooks", "goal-system-vscode.json"), "Run ./install.sh --target vscode-chat."),
  ];
  const mcpChecks = [
    installedRuntimePackageCheck("Run ./install.sh --target mcp."),
    check("MCP server file", await exists(mcpServerPath), mcpServerPath, "Run ./install.sh --target mcp."),
    check("MCP server self-test", mcpServerSelfTest.ok, mcpServerSelfTest.stdout || mcpServerSelfTest.stderr || mcpServerSelfTest.error, "Run ./install.sh --target mcp."),
    check("MCP config JSON", mcpConfig.exists && !mcpConfig.error, mcpConfig.error || mcpConfigPath, "Fix malformed mcp-config.json before reinstalling."),
    check("MCP server config", mcpServerConfigured, JSON.stringify(configuredMcpServer || null), "Run ./install.sh --target mcp."),
  ];
  const checks =
    options.target === "cli"
      ? cliChecks
      : options.target === "vscode-chat"
        ? vscodeChecks
        : options.target === "mcp"
          ? mcpChecks
          : [
              ...cliChecks,
              ...vscodeChecks.filter((item) => !cliChecks.some((existing) => existing.label === item.label)),
              ...mcpChecks.filter((item) => !cliChecks.some((existing) => existing.label === item.label) && !vscodeChecks.some((existing) => existing.label === item.label)),
            ];

  const report = {
    packageVersion: packageJson.version,
    target: options.target,
    home: options.home,
    cwd: options.cwd,
    paths: {
      copilotRoot,
      settingsPath,
      mcpConfigPath,
      extensionDir,
      goalctlPath,
      mcpServerPath,
    },
    checks,
    ok: checks.every((item) => item.ok),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  process.stdout.write(`Copilot Goal System doctor (${report.packageVersion})\n`);
  process.stdout.write(`Target: ${report.target}\n`);
  process.stdout.write(`Home: ${report.home}\n\n`);
  for (const item of checks) {
    process.stdout.write(`[${item.info ? "INFO" : item.ok ? "OK" : "ISSUE"}] ${item.label}`);
    if (item.details) process.stdout.write(`: ${item.details}`);
    process.stdout.write("\n");
    if (!item.ok && item.remediation) process.stdout.write(`  Fix: ${item.remediation}\n`);
  }
  process.stdout.write(`\nResult: ${report.ok ? "healthy" : "needs attention"}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
