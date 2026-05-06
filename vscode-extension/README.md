# Copilot Goal System

Copilot Goal System installs persisted goal mode for GitHub Copilot CLI from inside VS Code.

Use it when you want long-running Copilot CLI sessions to keep an active goal alive across compaction, tool drift, subagents, multiple sessions, and messy tasks that grow while they are being inspected.

## What It Installs

The extension installs the goal system into your local Copilot CLI profile:

- `~/.copilot/extensions/goal-system/`
- `~/.copilot/skills/goal/SKILL.md`
- `~/.copilot/hooks/goal-context.sh`
- hook entries in `~/.copilot/settings.json`
- a short reminder in `~/.copilot/copilot-instructions.md`

The installer preserves existing Copilot settings and writes backups before changing settings or instructions.

## Commands

Open the Command Palette and run:

- `Copilot Goal System: Install or Update Goal System`
- `Copilot Goal System: Show Install Status`
- `Copilot Goal System: Copy Runtime E2E Prompt`
- `Copilot Goal System: Open Documentation`
- `Copilot Goal System: Open Installed Files`
- `Copilot Goal System: Open Goal State Folder`

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

## Behavior

- Goal mode is manual and user-triggered.
- Goal state belongs to the main session only.
- Subagents cannot open, read, update, or close goals.
- Same-directory sessions stay isolated.
- Newly discovered in-scope issues are added to the live goal queue.
- Completion is refused without inspection evidence, verification results, requirement coverage, no remaining work, no blockers, resolved discovered issues, and a completion audit.

## Documentation

Full documentation, architecture notes, and troubleshooting live in the source repository:

[github.com/gabrimatic/copilot-goal-system](https://github.com/gabrimatic/copilot-goal-system)
