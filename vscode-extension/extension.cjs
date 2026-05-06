"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const DISPLAY_NAME = "Copilot Goal System";
const DOCS_URL = "https://github.com/gabrimatic/copilot-goal-system#readme";
const HOOK_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "preCompact",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "postToolUseFailure",
  "notification",
];

function activate(context) {
  const output = vscode.window.createOutputChannel(DISPLAY_NAME);
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotGoalSystem.install", () => installGoalSystem(context, output)),
    vscode.commands.registerCommand("copilotGoalSystem.status", () => showInstallStatus(output)),
    vscode.commands.registerCommand("copilotGoalSystem.copyPrompt", () => copyRuntimePrompt(context)),
    vscode.commands.registerCommand("copilotGoalSystem.openDocs", openDocs),
    vscode.commands.registerCommand("copilotGoalSystem.openInstalledFiles", () => revealPath(installedPaths().extensionDir)),
    vscode.commands.registerCommand("copilotGoalSystem.openStateFolder", () => revealPath(installedPaths().stateRoot))
  );
}

function deactivate() {}

function config() {
  return vscode.workspace.getConfiguration("copilotGoalSystem");
}

function configuredHome() {
  const override = String(config().get("homeOverride", "") || "").trim();
  if (!override) return os.homedir();
  if (override === "~") return os.homedir();
  if (override.startsWith("~/")) return path.join(os.homedir(), override.slice(2));
  return path.resolve(override);
}

function installedPaths() {
  const home = configuredHome();
  const copilotRoot = path.join(home, ".copilot");
  return {
    home,
    copilotRoot,
    extensionDir: path.join(copilotRoot, "extensions", "goal-system"),
    skillFile: path.join(copilotRoot, "skills", "goal", "SKILL.md"),
    hookFile: path.join(copilotRoot, "hooks", "goal-context.sh"),
    settingsFile: path.join(copilotRoot, "settings.json"),
    instructionsFile: path.join(copilotRoot, "copilot-instructions.md"),
    sdkPackage: path.join(copilotRoot, "extensions", "goal-system", "node_modules", "@github", "copilot-sdk", "package.json"),
    stateRoot: path.join(copilotRoot, "session-state", "goal-system"),
  };
}

function bundleRoot(context) {
  return path.join(context.extensionPath, "resources", "goal-system");
}

function installerPath(context) {
  return path.join(bundleRoot(context), "scripts", "install.mjs");
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function hookInstalled(settings, eventName) {
  const hooks = settings && settings.hooks && Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  return hooks.some((hook) => hook && hook.type === "command" && hook.bash === "$HOME/.copilot/hooks/goal-context.sh");
}

async function collectStatus() {
  const paths = installedPaths();
  let settings = null;
  let settingsError = "";

  if (await exists(paths.settingsFile)) {
    try {
      settings = await readJson(paths.settingsFile);
    } catch (error) {
      settingsError = error && error.message ? error.message : "settings.json could not be parsed";
    }
  }

  const hookEventsPresent = settings ? HOOK_EVENTS.filter((eventName) => hookInstalled(settings, eventName)) : [];

  return {
    paths,
    checks: [
      ["Extension package", await exists(path.join(paths.extensionDir, "package.json"))],
      ["Production dependencies", await exists(paths.sdkPackage)],
      ["Goal skill", await exists(paths.skillFile)],
      ["Hook helper", await exists(paths.hookFile)],
      ["Settings JSON", Boolean(settings) && !settingsError],
      ["All goal hook entries", hookEventsPresent.length === HOOK_EVENTS.length],
      ["Instruction snippet", await instructionsSnippetInstalled(paths.instructionsFile)],
    ],
    hookEventsPresent,
    settingsError,
  };
}

async function instructionsSnippetInstalled(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw.includes("<!-- copilot-goal-system snippet start -->");
  } catch {
    return false;
  }
}

function formatStatusReport(status) {
  const lines = [
    `${DISPLAY_NAME} install status`,
    "",
    `Home: ${status.paths.home}`,
    `Installed package: ${status.paths.extensionDir}`,
    "",
    ...status.checks.map(([label, ok]) => `${ok ? "OK" : "Missing"}  ${label}`),
    "",
    `Hook entries: ${status.hookEventsPresent.length}/${HOOK_EVENTS.length}`,
  ];

  if (status.settingsError) {
    lines.push("", `Settings error: ${status.settingsError}`);
  }

  lines.push(
    "",
    "After installing or updating, restart Copilot CLI and run:",
    "/skills reload",
    "/env"
  );

  return lines.join("\n");
}

async function showInstallStatus(output) {
  const status = await collectStatus();
  const report = formatStatusReport(status);
  output.clear();
  output.appendLine(report);
  output.show(true);

  const allOk = status.checks.every(([, ok]) => ok);
  const action = allOk ? "Open Docs" : "Install or Update";
  const result = await vscode.window.showInformationMessage(
    allOk ? "Copilot Goal System is installed." : "Copilot Goal System is not fully installed.",
    action
  );

  if (result === "Open Docs") await openDocs();
  if (result === "Install or Update") {
    await vscode.commands.executeCommand("copilotGoalSystem.install");
  }
}

function commandEnv(home) {
  const env = { ...process.env };
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function runStreaming(command, args, options, output) {
  return new Promise((resolve, reject) => {
    output.appendLine(`$ ${command} ${args.join(" ")}`);
    const child = cp.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.append(chunk));
    child.stderr.on("data", (chunk) => output.append(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function assertNode20(output, env) {
  let version = "";
  try {
    version = await capture("node", ["--version"], { env });
  } catch (error) {
    output.appendLine(error && error.message ? error.message : String(error));
    throw new Error("Node.js was not found on PATH. Install Node.js 20 or newer, then run install again.");
  }

  const major = Number((version.match(/^v?(\d+)/) || [])[1] || 0);
  output.appendLine(`Node.js: ${version}`);
  if (major < 20) {
    throw new Error(`Node.js 20 or newer is required. Current version: ${version}`);
  }
}

async function installGoalSystem(context, output) {
  const paths = installedPaths();
  const script = installerPath(context);

  if (!fs.existsSync(script)) {
    vscode.window.showErrorMessage("The bundled goal-system installer is missing. Reinstall this VS Code extension and try again.");
    return;
  }

  output.clear();
  output.show(true);
  output.appendLine(`${DISPLAY_NAME} installer`);
  output.appendLine(`Home: ${paths.home}`);
  output.appendLine(`Bundle: ${bundleRoot(context)}`);
  output.appendLine("");

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing Copilot Goal System",
        cancellable: false,
      },
      async (progress) => {
        const env = commandEnv(paths.home);
        progress.report({ message: "Checking Node.js" });
        await assertNode20(output, env);
        progress.report({ message: "Copying files and installing dependencies" });
        await runStreaming("node", [script], { cwd: bundleRoot(context), env }, output);
      }
    );

    if (config().get("showStatusAfterInstall", true)) {
      await showInstallStatus(output);
    } else {
      vscode.window.showInformationMessage("Copilot Goal System installed. Restart Copilot CLI, then run /skills reload and /env.");
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    output.appendLine("");
    output.appendLine(`Install failed: ${message}`);
    output.show(true);
    vscode.window.showErrorMessage(`Copilot Goal System install failed: ${message}`);
  }
}

async function copyRuntimePrompt(context) {
  const promptPath = path.join(bundleRoot(context), "tests", "prompts", "goal-system-reliability-e2e.md");
  try {
    const prompt = await fsp.readFile(promptPath, "utf8");
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage("Runtime E2E prompt copied. Paste it into Copilot CLI after installing the goal system.");
  } catch (error) {
    vscode.window.showErrorMessage(`Could not copy the runtime prompt: ${error.message || String(error)}`);
  }
}

async function openDocs() {
  await vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
}

async function revealPath(filePath) {
  try {
    await fsp.mkdir(filePath, { recursive: true });
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open ${filePath}: ${error.message || String(error)}`);
  }
}

module.exports = {
  activate,
  deactivate,
};
