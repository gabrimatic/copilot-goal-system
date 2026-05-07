# Copilot Goal System

Copilot Goal System is a VS Code installer for persisted goal mode in GitHub Copilot CLI and VS Code Copilot Chat.

Use it when long-running Copilot sessions need to keep an active goal alive across compaction, tool drift, subagents, multiple sessions, and tasks that grow during inspection.

## Install

1. Install this extension from the VS Code Marketplace.
2. Run `Copilot Goal System: Install Recommended Setup` from the Command Palette.
3. Restart Copilot CLI if you use CLI mode.
4. Reload VS Code or run `MCP: Reset Cached Tools` if you use VS Code Chat mode.

The Marketplace **Install** button installs the VS Code extension. The command installs the goal system into your local Copilot profile:

- `~/.copilot/extensions/goal-system/`
- `~/.copilot/skills/goal/SKILL.md`
- `~/.copilot/hooks/goal-context.sh`
- `~/.copilot/hooks/goal-system-vscode.json`
- `~/.copilot/agents/goal-system.agent.md`
- hook entries in `~/.copilot/settings.json`
- a `goalSystem` MCP server in the VS Code user `mcp.json`
- a short reminder in `~/.copilot/copilot-instructions.md`

The installer preserves existing Copilot and VS Code MCP settings and writes backups before changing files. On first startup, VS Code offers a one-time setup prompt and a compact status bar item so you do not need to discover the command manually.

After extension updates, VS Code compares the extension bundle with the installed files in `~/.copilot/extensions/goal-system/`. If the local runtime is stale, the status bar changes to `Goal Update` and VS Code prompts you to update the local Copilot files.

## Features

- Persists one active goal for the main Copilot session.
- Restores compact goal context after resume, compaction, and session restarts.
- Isolates same-directory sessions so parallel work does not share goal state by accident.
- Keeps subagents outside goal ownership; only the main session can open, read, update, or close goals.
- Tracks newly discovered in-scope issues as the task grows.
- Tracks renamed, merged, duplicate, superseded, and clearer-worded issues through evidence-backed issue resolutions.
- Warns on goal drift and blocks non-goal tool calls when the goal has gone stale.
- Refuses completion without inspection evidence, verification results, requirement coverage, resolved or evidence-covered discovered issues, no remaining work, no blockers, and a completion audit.
- Installs and updates from VS Code without cloning the repository.
- Shows a compact status bar item for installed, update-needed, setup-needed, installing, and error states.
- Adds a VS Code Chat custom agent, hook config, and local MCP goal tools.

## Commands

Open the Command Palette and run:

- `Copilot Goal System: Install Recommended Setup` installs the CLI and VS Code Chat adapters.
- `Copilot Goal System: Install into Copilot CLI` installs only the CLI adapter.
- `Copilot Goal System: Install into VS Code Copilot Chat` installs only the VS Code Chat adapter.
- `Copilot Goal System: Show Status` checks the package, dependencies, CLI hooks, VS Code hooks, custom agent, MCP server, and instruction snippet.
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

For VS Code Chat, reload VS Code or run `MCP: Reset Cached Tools`, then select the `Goal System` custom agent.

Start a goal:

```text
/goal
Make this project pass its test suite. Inspect first, fix every in-scope issue, verify with real evidence, and close only after the completion audit passes.
```

## Requirements

- VS Code 1.85 or newer
- Node.js 20 or newer on `PATH`
- GitHub Copilot CLI for CLI mode
- VS Code Copilot Chat with hooks and MCP enabled for VS Code Chat mode
- A bash-compatible shell for the CLI hook helper

The installer uses the current OS user's home directory by default. Set `copilotGoalSystem.homeOverride` when you need to install into a different local profile. Set `copilotGoalSystem.vscodeMcpConfigPathOverride` only when your VS Code MCP user config lives outside the detected profile path.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `copilotGoalSystem.homeOverride` | empty | Install into another local home directory. |
| `copilotGoalSystem.showStatusAfterInstall` | `true` | Show the status report after install or update. |
| `copilotGoalSystem.promptOnFirstRun` | `true` | Show the one-time setup prompt when setup is missing. |
| `copilotGoalSystem.promptOnUpdate` | `true` | Prompt when extension updates leave local Copilot runtime files stale. |
| `copilotGoalSystem.showStatusBar` | `true` | Show the compact setup/status item in the VS Code status bar. |
| `copilotGoalSystem.vscodeMcpConfigPathOverride` | empty | Use a custom VS Code MCP user config path. |

## Behavior

- Goal mode is manual and user-triggered.
- Goal state belongs to the main session only.
- Subagents cannot open, read, update, or close goals.
- Same-directory sessions stay isolated.
- Newly discovered in-scope issues are added to the live goal queue.
- Renamed, merged, duplicate, superseded, and clearer-worded discovered issues need specific evidence-backed issue resolutions.
- Completion is refused without inspection evidence, verification results, requirement coverage, no remaining work, no blockers, resolved or evidence-covered discovered issues, and a completion audit.

## Updates

VS Code updates the extension through the Marketplace. After an extension update, this extension checks whether the local Copilot runtime in `~/.copilot/extensions/goal-system/` is older than the bundled version. If it is stale, VS Code prompts you to update it. You can also run:

```text
Copilot Goal System: Install Recommended Setup
```

The source repository is the single editable source for the goal-system runtime. The Marketplace package contains a generated bundled copy so the installer works offline after the VSIX is installed.

## Documentation

Full documentation, architecture notes, and troubleshooting live in the source repository:

[github.com/gabrimatic/copilot-goal-system](https://github.com/gabrimatic/copilot-goal-system)
