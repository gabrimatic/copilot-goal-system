"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const DISPLAY_NAME = "Copilot Goal System";
const DOCS_URL = "https://github.com/gabrimatic/copilot-goal-system#readme";
const FIRST_INSTALL_PROMPT_KEY = "firstInstallPrompt.dismissed.v2";
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

let installInProgress = false;

function activate(context) {
  const output = vscode.window.createOutputChannel(DISPLAY_NAME);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.name = DISPLAY_NAME;
  context.subscriptions.push(output);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotGoalSystem.install", () => installGoalSystem(context, output, statusBar)),
    vscode.commands.registerCommand("copilotGoalSystem.status", () => showInstallStatus(output, statusBar)),
    vscode.commands.registerCommand("copilotGoalSystem.openWalkthrough", openWalkthrough),
    vscode.commands.registerCommand("copilotGoalSystem.copyPrompt", () => copyRuntimePrompt(context)),
    vscode.commands.registerCommand("copilotGoalSystem.openDocs", openDocs),
    vscode.commands.registerCommand("copilotGoalSystem.openInstalledFiles", () => revealPath(installedPaths().extensionDir, "Installed files")),
    vscode.commands.registerCommand("copilotGoalSystem.openStateFolder", () => revealPath(installedPaths().stateRoot, "Goal state folder")),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("copilotGoalSystem.showStatusBar") ||
        event.affectsConfiguration("copilotGoalSystem.homeOverride")
      ) {
        updateStatusBar(statusBar, output);
      }
    })
  );

  updateStatusBar(statusBar, output);
  setTimeout(() => {
    maybeOfferFirstInstall(context, output, statusBar).catch((error) => {
      output.appendLine(`First-run setup check failed: ${error.message || String(error)}`);
    });
  }, 1500);
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

function statusIsInstalled(status) {
  return status.checks.every(([, ok]) => ok);
}

function missingChecks(status) {
  return status.checks.filter(([, ok]) => !ok).map(([label]) => label);
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
  const installed = statusIsInstalled(status);
  const missing = missingChecks(status);
  const lines = [
    `${DISPLAY_NAME} install status`,
    "",
    `Home: ${status.paths.home}`,
    `Installed package: ${status.paths.extensionDir}`,
    `Result: ${installed ? "Installed" : "Setup needed"}`,
    "",
    "Checks:",
    ...status.checks.map(([label, ok]) => `[${ok ? "OK" : "Missing"}] ${label}`),
    "",
    `Hook entries: ${status.hookEventsPresent.length}/${HOOK_EVENTS.length}`,
  ];

  if (status.settingsError) {
    lines.push("", `Settings error: ${status.settingsError}`);
  }

  if (!installed && missing.length > 0) {
    lines.push("", "Missing:", ...missing.map((label) => `- ${label}`));
  }

  lines.push("", "Next steps:");
  if (installed) {
    lines.push("- Restart Copilot CLI after updates.", "- Run /skills reload", "- Run /env");
  } else {
    lines.push("- Run Copilot Goal System: Install into Copilot CLI.", "- Restart Copilot CLI.", "- Run /skills reload and /env.");
  }

  return lines.join("\n");
}

async function showInstallStatus(output, statusBar) {
  const status = await collectStatus();
  const report = formatStatusReport(status);
  output.clear();
  output.appendLine(report);
  output.show(true);
  await updateStatusBar(statusBar, output, status);

  const allOk = statusIsInstalled(status);
  const actions = allOk ? ["Open Docs", "Open State Folder"] : ["Install into Copilot CLI", "Open Walkthrough"];
  const result = await vscode.window.showInformationMessage(
    allOk ? "Copilot Goal System is installed." : "Copilot Goal System is not fully installed.",
    ...actions
  );

  if (result === "Open Docs") await openDocs();
  if (result === "Open State Folder") await revealPath(status.paths.stateRoot, "Goal state folder");
  if (result === "Open Walkthrough") await openWalkthrough();
  if (result === "Install into Copilot CLI") {
    await vscode.commands.executeCommand("copilotGoalSystem.install");
  }
}

async function maybeOfferFirstInstall(context, output, statusBar) {
  if (installInProgress || context.globalState.get(FIRST_INSTALL_PROMPT_KEY)) return;
  if (!config().get("promptOnFirstRun", true)) return;

  const status = await collectStatus();
  await updateStatusBar(statusBar, output, status);
  const allOk = statusIsInstalled(status);
  if (allOk) {
    await context.globalState.update(FIRST_INSTALL_PROMPT_KEY, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Set up Copilot Goal System in your local Copilot CLI profile to enable persisted /goal mode.",
    "Set Up Now",
    "Open Walkthrough",
    "Show Status",
    "Don't Ask Again"
  );

  await context.globalState.update(FIRST_INSTALL_PROMPT_KEY, true);

  if (choice === "Set Up Now") {
    await vscode.commands.executeCommand("copilotGoalSystem.install");
  } else if (choice === "Open Walkthrough") {
    await openWalkthrough();
  } else if (choice === "Show Status") {
    await showInstallStatus(output, statusBar);
  }
}

async function updateStatusBar(statusBar, output, knownStatus) {
  if (!statusBar) return;
  if (!config().get("showStatusBar", true)) {
    statusBar.hide();
    return;
  }

  try {
    const status = knownStatus || await collectStatus();
    const installed = statusIsInstalled(status);
    const missing = missingChecks(status);
    statusBar.command = "copilotGoalSystem.status";
    statusBar.text = installed ? "$(target) Goal" : "$(warning) Goal Setup";
    statusBar.tooltip = installed
      ? `${DISPLAY_NAME} is installed for ${status.paths.home}. Click to show status.`
      : `${DISPLAY_NAME} needs setup for ${status.paths.home}. Missing: ${missing.join(", ") || "unknown"}. Click to show status.`;
    statusBar.show();
  } catch (error) {
    statusBar.command = "copilotGoalSystem.status";
    statusBar.text = "$(error) Goal Setup";
    statusBar.tooltip = `${DISPLAY_NAME} status check failed: ${error.message || String(error)}`;
    statusBar.show();
    output.appendLine(`Status bar update failed: ${error.message || String(error)}`);
  }
}

function setStatusBarInstalling(statusBar) {
  if (!statusBar || !config().get("showStatusBar", true)) return;
  statusBar.command = "copilotGoalSystem.status";
  statusBar.text = "$(sync~spin) Goal Setup";
  statusBar.tooltip = "Installing Copilot Goal System into the local Copilot CLI profile.";
  statusBar.show();
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

async function installGoalSystem(context, output, statusBar) {
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

  installInProgress = true;
  setStatusBarInstalling(statusBar);
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

    await updateStatusBar(statusBar, output);
    if (config().get("showStatusAfterInstall", true)) {
      await showInstallStatus(output, statusBar);
    } else {
      vscode.window.showInformationMessage("Copilot Goal System installed. Restart Copilot CLI, then run /skills reload and /env.");
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    output.appendLine("");
    output.appendLine(`Install failed: ${message}`);
    output.show(true);
    await updateStatusBar(statusBar, output);
    vscode.window.showErrorMessage(`Copilot Goal System install failed: ${message}`);
  } finally {
    installInProgress = false;
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

async function openWalkthrough() {
  try {
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", "gabrimatic.copilot-goal-system#copilotGoalSystem.setup", false);
  } catch {
    await openDocs();
  }
}

async function revealPath(filePath, label) {
  try {
    if (!await exists(filePath)) {
      const actions = label === "Goal state folder" ? ["Show Status"] : ["Show Status", "Install into Copilot CLI"];
      const result = await vscode.window.showInformationMessage(
        label === "Goal state folder" ? `${label} does not exist yet. It appears after a goal runs.` : `${label} does not exist yet.`,
        ...actions
      );
      if (result === "Show Status") await vscode.commands.executeCommand("copilotGoalSystem.status");
      if (result === "Install into Copilot CLI") await vscode.commands.executeCommand("copilotGoalSystem.install");
      return;
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open ${filePath}: ${error.message || String(error)}`);
  }
}

module.exports = {
  activate,
  deactivate,
};
