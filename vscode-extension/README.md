# Copilot Goal System

Copilot Goal System is a VS Code installer for persisted goal mode in GitHub Copilot CLI.

Use it when long-running Copilot CLI sessions need to keep an active goal alive across compaction, tool drift, subagents, multiple sessions, and tasks that grow during inspection.

## Install

1. Install this extension from the VS Code Marketplace.
2. Run `Copilot Goal System: Install into Copilot CLI` from the Command Palette.
3. Restart Copilot CLI.
4. Run `/skills reload` and `/env` in Copilot CLI.

The Marketplace **Install** button installs the VS Code extension. The command installs the goal system into your local Copilot CLI profile:

- `~/.copilot/extensions/goal-system/`
- `~/.copilot/skills/goal/SKILL.md`
- `~/.copilot/hooks/goal-context.sh`
- hook entries in `~/.copilot/settings.json`
- a short reminder in `~/.copilot/copilot-instructions.md`

The installer preserves existing Copilot settings and writes backups before changing settings or instructions. On first startup, VS Code offers a one-time setup prompt and a compact status bar item so you do not need to discover the command manually.

## Features

- Persists one active goal for the main Copilot CLI session.
- Restores compact goal context after resume, compaction, and session restarts.
- Isolates same-directory sessions so parallel work does not share goal state by accident.
- Keeps subagents outside goal ownership; only the main session can open, read, update, or close goals.
- Tracks newly discovered in-scope issues as the task grows.
- Warns on goal drift and blocks non-goal tool calls when the goal has gone stale.
- Refuses completion without inspection evidence, verification results, requirement coverage, resolved discovered issues, no remaining work, no blockers, and a completion audit.
- Installs and updates from VS Code without cloning the repository.
- Shows a compact status bar item for installed, setup-needed, installing, and error states.

## Commands

Open the Command Palette and run:

- `Copilot Goal System: Install into Copilot CLI` copies the bundled runtime into `~/.copilot`, installs dependencies, merges hooks, and installs the goal skill.
- `Copilot Goal System: Show Status` checks the package, dependencies, skill, hook helper, settings entries, and instruction snippet.
- `Copilot Goal System: Open Setup Walkthrough` opens the guided VS Code setup steps.
- `Copilot Goal System: Copy Test Prompt` copies a fixture prompt for testing the full goal loop in Copilot CLI.
- `Copilot Goal System: Open Documentation` opens the source documentation.
- `Copilot Goal System: Open Installed Files` opens the installed local package directory.
- `Copilot Goal System: Open Goal State Folder` opens the persisted goal-state directory.

After install, restart Copilot CLI and run:

```text
/skills reload
/env
```

Start a goal:

```text
/goal
Make this project pass its test suite. Inspect first, fix every in-scope issue, verify with real evidence, and close only after the completion audit passes.
```

## Requirements

- VS Code 1.85 or newer
- Node.js 20 or newer on `PATH`
- GitHub Copilot CLI
- A bash-compatible shell for the hook helper

The installer uses the current OS user's home directory by default. Set `copilotGoalSystem.homeOverride` when you need to install into a different local profile.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `copilotGoalSystem.homeOverride` | empty | Install into another local home directory. |
| `copilotGoalSystem.showStatusAfterInstall` | `true` | Show the status report after install or update. |
| `copilotGoalSystem.promptOnFirstRun` | `true` | Show the one-time setup prompt when Copilot CLI setup is missing. |
| `copilotGoalSystem.showStatusBar` | `true` | Show the compact setup/status item in the VS Code status bar. |

## Behavior

- Goal mode is manual and user-triggered.
- Goal state belongs to the main session only.
- Subagents cannot open, read, update, or close goals.
- Same-directory sessions stay isolated.
- Newly discovered in-scope issues are added to the live goal queue.
- Completion is refused without inspection evidence, verification results, requirement coverage, no remaining work, no blockers, resolved discovered issues, and a completion audit.

## Updates

VS Code updates the extension through the Marketplace. Run `Copilot Goal System: Install into Copilot CLI` after an extension update to copy the bundled goal-system version into Copilot CLI.

The source repository is the single editable source for the goal-system runtime. The Marketplace package contains a generated bundled copy so the installer works offline after the VSIX is installed.

## Documentation

Full documentation, architecture notes, and troubleshooting live in the source repository:

[github.com/gabrimatic/copilot-goal-system](https://github.com/gabrimatic/copilot-goal-system)
