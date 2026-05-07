# VS Code Copilot Chat

The VS Code Copilot Chat adapter brings persisted goal mode to official VS Code Chat through a custom agent, lifecycle hooks, and a local MCP server.

This adapter is **preview** because VS Code agent hooks and agent plugins are Preview surfaces. The Copilot CLI adapter remains the stable strict mode.

## Requirements

| Requirement | Notes |
|-------------|-------|
| VS Code with Copilot Chat | Agent mode must be available. |
| Node.js `>= 20` | Runs the hook runner and MCP server. |
| MCP access | Organizations can disable MCP. |
| Hook access | Organizations can disable agent hooks. |

## Install

From VS Code Marketplace, run:

```text
Copilot Goal System: Install Recommended Setup
```

From a cloned repository, run:

```bash
./install.sh --target vscode-chat
```

Install both adapters:

```bash
./install.sh --target all
```

After install, reload VS Code or run:

```text
MCP: Reset Cached Tools
```

Then select the `Goal System` custom agent in Copilot Chat.

## Installed Files

| Path | Purpose |
|------|---------|
| `~/.copilot/extensions/goal-system/` | Shared package, core, adapters, tests, docs, and dependencies. |
| `~/.copilot/agents/goal-system.agent.md` | VS Code custom agent instructions. |
| `~/.copilot/hooks/goal-system-vscode.json` | VS Code hook config with PascalCase lifecycle events. |
| VS Code user `mcp.json` | Adds the `goalSystem` stdio MCP server. |
| `~/.copilot/session-state/goal-system/` | Shared persisted goal state. |

The installer writes backups before changing an existing MCP config, hook config, or custom agent file.

## What It Enforces

The VS Code Chat adapter uses official VS Code hook events:

| Hook | Behavior |
|------|----------|
| `SessionStart` | Injects the current `sessionId`, `cwd`, and active goal context. |
| `PreToolUse` | Warns and then denies non-goal tools after repeated goal-state drift. |
| `PostToolUse` | Records non-goal tool history into the persisted goal. |
| `PreCompact` | Writes a compact snapshot before conversation compaction. |
| `SubagentStart` | Gives subagents a boundary message without exposing goal state. |
| `SubagentStop` | Lets subagents finish without taking goal ownership. |
| `Stop` | Blocks premature completion while an active goal remains open. |

Goal state remains isolated by `sessionId` and `cwd`. Multiple same-directory sessions do not silently merge.

## MCP Tools

The local MCP server exposes:

```text
goal_system_status
goal_system_open
goal_system_update
goal_system_close
```

All tools require the `sessionId` and `cwd` that the hook injects into the chat context. This keeps VS Code Chat sessions isolated even when several sessions share one workspace.

## Current Limits

- VS Code hooks are Preview and can change.
- Organizations can disable hooks or MCP.
- The adapter cannot force goal behavior if the user does not use the `Goal System` agent and the model ignores available MCP tools.
- Hook output depends on VS Code honoring the documented lifecycle events.

When those surfaces are enabled, the adapter gives VS Code Chat the same core persistence, drift control, subagent boundary, and proof-based completion rules as the CLI adapter.

## Troubleshooting

### Goal tools do not appear

Run:

```text
MCP: Reset Cached Tools
```

Then reload VS Code. If tools still do not appear, run:

```text
MCP: List Servers
```

Confirm the `goalSystem` server is present and starts without errors.

### Hooks do not run

Open the `GitHub Copilot Chat Hooks` output channel in VS Code. If no goal hook runs, check:

- `~/.copilot/hooks/goal-system-vscode.json`
- VS Code setting `chat.hookFilesLocations`
- organization policy for agent hooks

### Stop is blocked

An active goal is still open. Continue the remaining work or call `goal_system_close` as complete, blocked, or cancelled with exact evidence.
