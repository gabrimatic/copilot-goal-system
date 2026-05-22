#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  cliMcpServerDetails,
  cliMcpServerInstalled,
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
  "postToolUseFailure",
  "notification",
];

function parseArgs(argv) {
  const options = {
    home: process.env.HOME || os.homedir(),
    cwd: process.cwd(),
    target: "cli",
    json: false,
    vscodeMcpConfigPath: process.env.GOAL_SYSTEM_VSCODE_MCP_CONFIG_PATH || "",
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
    } else if (arg === "--vscode-mcp-config") {
      options.vscodeMcpConfigPath = argv[index + 1] || options.vscodeMcpConfigPath;
      index += 1;
    } else if (arg.startsWith("--vscode-mcp-config=")) {
      options.vscodeMcpConfigPath = arg.slice("--vscode-mcp-config=".length);
    }
  }
  if (!["cli", "vscode-chat", "all"].includes(options.target)) {
    throw new Error(`Unknown --target "${options.target}". Use cli, vscode-chat, or all.`);
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

function defaultVscodeMcpConfigPath(home, override = "") {
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code", "User", "mcp.json");
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

function check(label, ok, details = "", remediation = "") {
  return {
    label,
    ok: Boolean(ok),
    details,
    remediation,
  };
}

function resolveMaybePath(value, home = os.homedir()) {
  const expanded = String(value || "").startsWith("~/") ? path.join(home, String(value || "").slice(2)) : String(value || "");
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
}

function vscodeMcpServerDetails(config, options = {}) {
  const server = config && config.servers && config.servers.goalSystem;
  if (!server || !Array.isArray(server.args)) return { ok: false, reason: "goalSystem server is missing or has no args" };
  if (server.type !== "stdio") return { ok: false, reason: `goalSystem type is ${server.type || "missing"}` };
  if (!server.command) return { ok: false, reason: "goalSystem command is missing" };
  const scriptArg = server.args.find((arg) => /mcp-server\.mjs$/.test(String(arg)));
  if (!scriptArg) return { ok: false, reason: "goalSystem args do not point at mcp-server.mjs" };
  const scriptPath = resolveMaybePath(scriptArg, options.home);
  const expectedScriptPath = options.expectedScriptPath ? resolveMaybePath(options.expectedScriptPath, options.home) : "";
  if (expectedScriptPath && scriptPath !== expectedScriptPath) {
    return { ok: false, reason: `goalSystem points at ${scriptPath}, expected ${expectedScriptPath}`, command: server.command, args: server.args, env: server.env || {}, scriptPath };
  }
  return { ok: true, reason: "configured", command: server.command, args: server.args, env: server.env || {}, scriptPath };
}

function profileEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: copilotRootForHome(home) };
}

function mcpConfigSelfTest(details, home) {
  if (!details.ok) {
    return { ok: false, status: 1, stdout: "", stderr: details.reason || "MCP server is not configured", error: "" };
  }
  return run(details.command, [...details.args, "--self-test"], {
    env: { ...profileEnv(home), ...(details.env || {}) },
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const copilotRoot = copilotRootForHome(options.home);
  const extensionDir = path.join(copilotRoot, "extensions", "goal-system");
  const settingsPath = path.join(copilotRoot, "settings.json");
  const cliMcpConfigPath = path.join(copilotRoot, "mcp-config.json");
  const vscodeMcpConfigPath = defaultVscodeMcpConfigPath(options.home, options.vscodeMcpConfigPath);
  const mcpServerPath = path.join(extensionDir, "adapters", "vscode-chat", "mcp-server.mjs");

  const settings = await readJsonIfExists(settingsPath);
  const cliMcpConfig = await readJsonIfExists(cliMcpConfigPath);
  const vscodeMcpConfig = await readJsonIfExists(vscodeMcpConfigPath);
  const installedPackage = await readJsonIfExists(path.join(extensionDir, "package.json"));
  const copilotVersion = run("copilot", ["--version"], { env: profileEnv(options.home) });
  const jqVersion = run("jq", ["--version"], { env: profileEnv(options.home) });
  const cliMcpDetails = cliMcpServerDetails(cliMcpConfig.value, { home: options.home, expectedScriptPath: mcpServerPath });
  const vscodeMcpDetails = vscodeMcpServerDetails(vscodeMcpConfig.value, { home: options.home, expectedScriptPath: mcpServerPath });
  const cliMcpSelfTest = mcpConfigSelfTest(cliMcpDetails, options.home);
  const vscodeMcpSelfTest = mcpConfigSelfTest(vscodeMcpDetails, options.home);
  const copilotMcpGet = copilotVersion.ok ? run("copilot", ["mcp", "get", "goalSystem", "--json"], { env: profileEnv(options.home) }) : { ok: false, stderr: "Copilot CLI command is unavailable" };

  const cliHookEventsPresent = settings.value ? CLI_HOOK_EVENTS.filter((eventName) => hookInstalled(settings.value, eventName)) : [];
  const duplicateCliGoalHooks = settings.value ? countDuplicateGoalHooks(settings.value, CLI_HOOK_EVENTS) : {};
  const staleCliDriftHookEvents = settings.value ? findStaleDriftHookEvents(settings.value) : [];
  const cliChecks = [
    check("Copilot CLI command", copilotVersion.ok, copilotVersion.stdout || copilotVersion.stderr || copilotVersion.error, "Install or repair GitHub Copilot CLI."),
    check("Installed runtime package", installedPackage.value?.version === packageJson.version, installedPackage.value?.version || "missing", "Run ./install.sh --target cli."),
    check("Goal skill file", await exists(path.join(copilotRoot, "skills", "goal", "SKILL.md")), path.join(copilotRoot, "skills", "goal", "SKILL.md"), "Run ./install.sh --target cli."),
    check("CLI hook helper", await exists(path.join(copilotRoot, "hooks", "goal-context.sh")), path.join(copilotRoot, "hooks", "goal-context.sh"), "Run ./install.sh --target cli."),
    check("CLI hook parser dependency", jqVersion.ok, jqVersion.stdout || jqVersion.stderr || jqVersion.error || "jq unavailable", "Install jq, then restart Copilot CLI."),
    check("CLI settings JSON", settings.exists && !settings.error, settings.error || settingsPath, "Fix malformed settings.json before reinstalling."),
    check("CLI hooks enabled", settings.value && settings.value.disableAllHooks !== true, settings.value?.disableAllHooks === true ? "disableAllHooks=true" : "disableAllHooks=false", "Set disableAllHooks to false or remove it, then restart Copilot CLI."),
    check("All CLI lifecycle hooks", cliHookEventsPresent.length === CLI_HOOK_EVENTS.length, `${cliHookEventsPresent.length}/${CLI_HOOK_EVENTS.length}`, "Run ./install.sh --target cli, then restart Copilot CLI."),
    check("No duplicate CLI goal hooks", Object.keys(duplicateCliGoalHooks).length === 0, JSON.stringify(duplicateCliGoalHooks), "Run ./install.sh --target cli to normalize direct duplicates."),
    check("No stale hard drift hooks", staleCliDriftHookEvents.length === 0, staleCliDriftHookEvents.join(", ") || "none", "Run ./install.sh --target cli to remove stale preToolUse/postToolUse goal hooks."),
    check("Copilot CLI MCP goal server", cliMcpServerInstalled(cliMcpConfig.value, { home: options.home, expectedScriptPath: mcpServerPath }), cliMcpDetails.ok ? cliMcpDetails.scriptPath : cliMcpDetails.reason, "Run ./install.sh --target cli, then use /mcp show in Copilot CLI."),
    check("Configured CLI MCP self-test", cliMcpSelfTest.ok, cliMcpSelfTest.stdout || cliMcpSelfTest.stderr || cliMcpSelfTest.error, "Run npm ci and ./install.sh --target cli."),
    check("Copilot CLI loads goalSystem MCP", copilotMcpGet.ok, copilotMcpGet.stdout || copilotMcpGet.stderr || copilotMcpGet.error, "Run copilot mcp get goalSystem --json. If missing, rerun ./install.sh --target cli and restart Copilot CLI."),
  ];
  const vscodeChecks = [
    check("Installed runtime package", installedPackage.value?.version === packageJson.version, installedPackage.value?.version || "missing", "Run ./install.sh --target all."),
    check("VS Code MCP goal server", vscodeMcpDetails.ok, vscodeMcpDetails.ok ? vscodeMcpDetails.scriptPath : vscodeMcpDetails.reason, "Run ./install.sh --target vscode-chat and reload VS Code."),
    check("Configured VS Code MCP self-test", vscodeMcpSelfTest.ok, vscodeMcpSelfTest.stdout || vscodeMcpSelfTest.stderr || vscodeMcpSelfTest.error, "Run npm ci and ./install.sh --target all."),
  ];
  const checks =
    options.target === "cli"
      ? cliChecks
      : options.target === "vscode-chat"
        ? vscodeChecks
        : [...cliChecks, ...vscodeChecks.filter((item) => !cliChecks.some((existing) => existing.label === item.label))];

  const report = {
    packageVersion: packageJson.version,
    target: options.target,
    home: options.home,
    cwd: options.cwd,
    paths: {
      copilotRoot,
      settingsPath,
      cliMcpConfigPath,
      vscodeMcpConfigPath,
      extensionDir,
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
    process.stdout.write(`[${item.ok ? "OK" : "ISSUE"}] ${item.label}`);
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
