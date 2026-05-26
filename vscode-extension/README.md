# Copilot Goal System

Copilot Goal System installs persisted goal mode for GitHub Copilot CLI and VS Code Copilot Chat.

Use it when long-running Copilot work needs to keep one active goal alive across compaction, tool drift, subagents, multiple sessions, and tasks that grow during inspection.

## Install

1. Install this extension from the VS Code Marketplace.
2. Run `Copilot Goal System: Install Recommended Setup` from the Command Palette.
3. Restart Copilot CLI if you use CLI mode.
4. Reload VS Code if you use VS Code Chat mode.

The Marketplace **Install** button installs the VS Code extension. The command installs the goal system into your local Copilot profile:

- `~/.copilot/extensions/goal-system/`
- `~/.copilot/skills/goal/SKILL.md`
- `~/.copilot/hooks/goal-context.sh`
- `~/.copilot/hooks/goal-system-vscode.json`
- `~/.copilot/agents/goal-system.agent.md`
- hook entries in `~/.copilot/settings.json`
- `~/.copilot/extensions/goal-system/bin/goalctl.mjs`
- a short reminder in `~/.copilot/copilot-instructions.md`

The installer preserves existing Copilot settings and writes backups before changing files. It accepts JSONC in Copilot CLI `settings.json`, including comments and trailing commas. If that settings file is malformed or is not a JSON object, the installer preserves the original as an `*.invalid-backup-*` file, recreates a clean JSON object, and then applies the goal-system entries. Config backups keep the original file permissions, and newly created config files default to owner-only permissions. Runtime updates prepare dependencies before swapping the installed local runtime, so failed dependency installs leave the previous runtime in place. On first startup, VS Code offers a one-time setup prompt and a compact status bar item.
Current installs use local hooks, direct VS Code tools, and `goalctl`; they do not create server config.

After extension updates, VS Code compares the extension bundle with the installed files in `~/.copilot/extensions/goal-system/`. If the local runtime is stale, the status bar changes to `Goal Update` and VS Code prompts you to update the local Copilot files. Updates replace the installed runtime snapshot so stale files from older releases do not remain active.

## Features

| Area | What it does |
|------|--------------|
| Goal state | Persists one active goal for the main Copilot session, restores compact context after resume or compaction, and loads one unambiguous same-directory goal on explicit continuation. |
| Session boundaries | Keeps parallel same-directory sessions isolated and keeps subagents outside goal ownership. |
| Completion gates | Tracks newly discovered and renamed issues, warns on stale goal state, keeps drift recoverable, and refuses completion without inspection evidence, verification results, requirement coverage, no remaining work, no blockers, and a completion audit. |
| VS Code setup | Installs and updates from VS Code, adds the `Goal System` custom agent, configures hooks and direct goal tools, and shows setup or update state in the status bar. |

## Commands

Open the Command Palette and run:

- `Copilot Goal System: Install Recommended Setup` installs the CLI and VS Code Chat adapters.
- `Copilot Goal System: Install into Copilot CLI` installs only the CLI adapter.
- `Copilot Goal System: Install into VS Code Copilot Chat` installs only the VS Code Chat adapter.
- `Copilot Goal System: Show Status` checks the package, dependencies, CLI hooks, VS Code hooks, custom agent, goalctl, and instruction snippet.
- `Copilot Goal System: Open Setup Walkthrough` opens the guided VS Code setup steps.
- `Copilot Goal System: Copy Test Prompt` copies a fixture prompt for testing the full goal loop.
- `Copilot Goal System: Open Documentation` opens the source documentation.
- `Copilot Goal System: Open Installed Files` opens the installed local package directory.
- `Copilot Goal System: Open Goal State Folder` opens the persisted goal-state directory.

For CLI mode, restart Copilot CLI and run:

```text
/skills reload
/env
```

For VS Code Chat, reload VS Code, then select the `Goal System` custom agent.

Start a goal:

```text
/goal
Make this project pass its test suite. Inspect first, fix every in-scope issue, verify with real evidence, and close only after the completion audit passes.
```

## Requirements

- VS Code 1.95 or newer
- Node.js 20 or newer on `PATH`
- GitHub Copilot CLI for CLI mode
- VS Code Copilot Chat with hooks and extension language model tools enabled for VS Code Chat mode
- A bash-compatible shell and `jq` for the CLI hook helper

VS Code asks for confirmation before extension-contributed language model tools run. Choose Always Allow for the Goal System tools if you want Copilot Chat to update goal state without repeated prompts. If the tools are unavailable or blocked by policy, use the local `goalctl` command with the `sessionId` and `cwd` from hook context.

The installer uses your current OS account's home directory by default. Set `copilotGoalSystem.homeOverride` when you need to install into a different local profile.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `copilotGoalSystem.homeOverride` | empty | Install into another local home directory. |
| `copilotGoalSystem.showStatusAfterInstall` | `true` | Show the status report after install or update. |
| `copilotGoalSystem.promptOnFirstRun` | `true` | Show the one-time setup prompt when setup is missing. |
| `copilotGoalSystem.promptOnUpdate` | `true` | Prompt when extension updates leave local Copilot runtime files stale. |
| `copilotGoalSystem.showStatusBar` | `true` | Show the compact setup/status item in the VS Code status bar. |

## Behavior

- Goal mode is manual and explicitly triggered.
- Goal state belongs to the main session only.
- Subagents cannot open, read, update, or close goals.
- Same-directory sessions stay isolated.
- Duplicate records for the same resumed goal are treated as one goal during continuation.
- Newly discovered in-scope issues are added to the live goal queue.
- Renamed, merged, duplicate, superseded, and clearer-worded discovered issues need specific evidence-backed issue resolutions.
- Completion is refused without inspection evidence, verification results, requirement coverage, no remaining work, no blockers, resolved or evidence-covered discovered issues, and a completion audit.

## Updates

VS Code updates the extension through the Marketplace. After an extension update, this extension checks whether the local Copilot runtime in `~/.copilot/extensions/goal-system/` is older than the bundled version. If it is stale, VS Code prompts you to update it. You can also run:

```text
Copilot Goal System: Install Recommended Setup
```

The source repository is the single editable source for the goal-system runtime. The Marketplace package contains a generated bundled copy so the installer works offline after the VSIX is installed.
The local runtime update replaces the installed snapshot rather than overlaying files.

## Documentation

Full documentation, architecture notes, and troubleshooting live in the source repository:

[github.com/gabrimatic/copilot-goal-system](https://github.com/gabrimatic/copilot-goal-system)
