# Install Guide

This guide installs Copilot Goal System into your local GitHub Copilot CLI profile.

## Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | `>= 20` | Required by the Copilot SDK package. |
| npm | `>= 10` | Used by the installer to install production dependencies. |
| GitHub Copilot CLI | current | Restart it after install. |
| macOS or Linux shell | bash-compatible | The hook helper is a shell script. |

## Preferred setup

### VS Code Marketplace

Install the extension:

```text
gabrimatic.copilot-goal-system
```

Then run this Command Palette command:

```text
Copilot Goal System: Install into Copilot CLI
```

The VS Code extension uses the current OS user's home directory by default. Set `copilotGoalSystem.homeOverride` when you need to install into a different local profile.

### Terminal

Clone with SSH:

```bash
git clone git@github.com:gabrimatic/copilot-goal-system.git
cd copilot-goal-system
./install.sh
```

Clone with HTTPS:

```bash
git clone https://github.com/gabrimatic/copilot-goal-system.git
cd copilot-goal-system
./install.sh
```

Restart Copilot CLI:

```text
/skills reload
/env
```

## What gets installed

| Path | Purpose |
|------|---------|
| `~/.copilot/extensions/goal-system/` | Extension package, tests, docs, hook config, and dependencies. |
| `~/.copilot/skills/goal/SKILL.md` | Goal-mode skill used by Copilot. |
| `~/.copilot/hooks/goal-context.sh` | CLI lifecycle hook helper. |
| `~/.copilot/settings.json` | Hook entries are merged into existing settings. |
| `~/.copilot/copilot-instructions.md` | A short goal-system reminder is appended once. |

The installer preserves existing settings. It appends missing goal hooks and leaves unrelated hooks alone.

## Hook entries

The installer adds these hook events:

```text
sessionStart
userPromptSubmitted
preCompact
agentStop
subagentStart
subagentStop
postToolUseFailure
notification
```

Repository-level hook config is optional. Copy `.github/hooks/goal-system.json` into a repository when you want the hook setup committed with that project.

## Update

From VS Code, update the extension through the Marketplace, then run:

```text
Copilot Goal System: Install into Copilot CLI
```

From a cloned repository:

```bash
cd copilot-goal-system
git pull
npm ci
npm run verify
./install.sh
```

Restart Copilot CLI after updating.

## Uninstall

Remove the installed files:

```bash
rm -rf ~/.copilot/extensions/goal-system
rm -rf ~/.copilot/skills/goal
rm -f ~/.copilot/hooks/goal-context.sh
```

Then edit `~/.copilot/settings.json` and remove hook entries whose `bash` value is:

```text
$HOME/.copilot/hooks/goal-context.sh
```

Also remove the marked snippet in `~/.copilot/copilot-instructions.md`:

```text
<!-- copilot-goal-system snippet start -->
...
<!-- copilot-goal-system snippet end -->
```

## Troubleshooting

### `/goal` only says the skill loaded

Run:

```text
/skills reload
/env
```

Confirm the `goal` skill appears and the extension tools are visible. Restart Copilot CLI if the extension was installed while a session was already running.

### Goal state does not resume after compaction

Check state files:

```bash
find ~/.copilot/session-state -path '*goal*' -maxdepth 5 -type f | sort
```

Run `goal_system_status` inside Copilot before continuing. If no state exists, start a new goal and inspect before acting.

### Tool calls get denied

The drift guard is working. Call `goal_system_update` with real progress, inspection evidence, verification results, remaining work, or blockers.

### A stop is blocked

An open goal still exists. Continue the remaining work, or call `goal_system_close` as complete, blocked, or cancelled with evidence.

### npm install fails

Run manually:

```bash
cd ~/.copilot/extensions/goal-system
npm ci --omit=dev --ignore-scripts
```

If Node is too old, install Node.js >= 20 and rerun `./install.sh`.
