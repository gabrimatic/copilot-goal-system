# Copilot Goal System

[![CI](https://github.com/gabrimatic/copilot-goal-system/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrimatic/copilot-goal-system/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20.19%2B%20%7C%2022.12%2B-brightgreen)](https://nodejs.org)
[![Copilot CLI](https://img.shields.io/badge/GitHub_Copilot_CLI-supported-blue)](https://docs.github.com/copilot)
[![VS Code Chat](https://img.shields.io/badge/VS_Code_Copilot_Chat-preview-orange)](https://gabrimatic.github.io/copilot-goal-system/product/vscode-chat/)

Copilot Goal System keeps long-running Copilot work tied to one persisted Active Goal.

It gives GitHub Copilot CLI, MCP, and VS Code Copilot Chat local goal state, lifecycle hooks, subagent boundaries, drift warnings, and completion gates that require proof before a goal can close. Use it when a task needs to survive compaction, parallel sessions, subagents, and the moment where inspection turns one issue into ten.

[Quick start](#quick-start) · [What it adds](#what-it-adds) · [How it works](#how-it-works) · [Docs](https://gabrimatic.github.io/copilot-goal-system/) · [Security](./SECURITY.md)

---

## Quick start

Runtime: **Node.js 20.19+ or 22.12+** and either **GitHub Copilot CLI** or **VS Code Copilot Chat**. CLI hook mode also needs a bash-compatible shell and `jq`.

### VS Code

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gabrimatic.copilot-goal-system).

After VS Code installs the extension, run:

```text
Copilot Goal System: Install Recommended Setup
```

The Marketplace **Install** button installs the VS Code wrapper. The command above installs the local goal system for your current OS account:

- Copilot CLI stable adapter
- VS Code Copilot Chat preview adapter
- Copilot CLI MCP stdio server
- local goal tools
- lifecycle hooks
- the Goal System custom agent

After extension updates, VS Code checks whether `~/.copilot/extensions/goal-system/` is older than the bundled runtime. If it is stale, the status bar switches to `Goal Update` and VS Code prompts you to update the local Copilot files. Updates replace the installed runtime snapshot so removed files do not linger in `~/.copilot/extensions/goal-system/`.

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

Install from the published docs site:

```bash
curl -fsSL https://gabrimatic.github.io/copilot-goal-system/install.sh | bash
```

`./install.sh` installs the Copilot CLI adapter by default. Use `./install.sh --target all` to install CLI, MCP, and VS Code Chat support.

For CLI mode, restart Copilot CLI, then run:

```text
/skills reload
/env
```

For VS Code Chat, reload VS Code, then select the `Goal System` custom agent in Copilot Chat.

Start a goal in either surface:

```text
/goal
Make this project pass its test suite. Inspect first, fix every in-scope issue, verify with real evidence, and finish only after the completion audit passes.
```

## What it adds

| Area | What it does |
|------|--------------|
| Goal tools | `goal_system_open`, `goal_system_status`, `goal_system_checkpoint`, and `goal_system_finish` create, reload, checkpoint, and finish persisted goals. Compatibility `update` and `close` tools remain available for older or advanced flows. Completion is refused without proof. |
| MCP stdio server | Adds `goalSystem` to `~/.copilot/mcp-config.json`, exposing the same status, open, checkpoint, finish, update, close, block, and cancel operations through MCP. |
| Lifecycle hooks | Restore goal context, write compact snapshots, block premature stop, warn on stale non-goal tool drift, and keep subagents outside goal ownership. |
| VS Code Chat adapter | Adds the `Goal System` custom agent, VS Code hook config, direct VS Code goal tools, and local `goalctl` fallback. |
| Goal contract | Installs the `goal` skill and instruction snippet so Copilot knows the work is execution, not a loose reminder. |

Default behavior:

- Goal mode is **manual**. Normal prompts do not become goals.
- `/goal` activation is recognized as a real slash command and creates a persisted draft goal before work begins.
- Goal state is **main-session only**. Subagents cannot open, update, read, or close goals.
- Same-directory sessions are **isolated**. Automatic continuation happens only when exactly one open same-directory goal exists, and repeated records for the same resumed goal are treated as one goal.
- The remaining queue is **dynamic**. Newly discovered in-scope issues are added to the goal and must be resolved before completion.
- Discovered issues can be **renamed, merged, deduplicated, superseded, or resolved under clearer wording** only with evidence-backed `issueResolutions`.
- Completion requires **inspection evidence, validation proof, verification results, requirement coverage, no remaining work, no blockers, resolved or evidence-covered discovered issues, and a completion audit**.
- Tool drift is controlled without deadlocking the session. After three non-goal tool calls without `goal_system_checkpoint` or a compatible goal update, Copilot gets a warning. At five, it gets a critical recovery reminder, but the tool call is still allowed so the agent can inspect, repair, or checkpoint manually when goal tools are unavailable.
- Stop hooks are blocked while an open goal remains active, with a hard continuation directive that tells Copilot to reload status, continue work, checkpoint persisted state, and finish only with evidence.

## Install details

`./install.sh` supports three targets:

```bash
./install.sh --target cli
./install.sh --target mcp
./install.sh --target vscode-chat
./install.sh --target all
```

The default target is `cli`.

For Copilot CLI, the installer:

1. Copies this package to `~/.copilot/extensions/goal-system/`.
2. Installs production dependencies inside that extension directory.
3. Installs the goal skill at `~/.copilot/skills/goal/SKILL.md`.
4. Installs the hook helper at `~/.copilot/hooks/goal-context.sh` and merges hook entries into `~/.copilot/settings.json`.
5. Installs `~/.copilot/extensions/goal-system/bin/goalctl.mjs` as the local fallback for goal status, open, checkpoint, finish, block, cancel, update, and close.

For MCP, the installer:

1. Installs the same runtime under `~/.copilot/extensions/goal-system/`.
2. Marks `~/.copilot/extensions/goal-system/adapters/mcp/server.mjs` executable.
3. Adds or updates `mcpServers.goalSystem` in `~/.copilot/mcp-config.json` with a local stdio command and `tools: ["*"]`.

For VS Code Copilot Chat, the installer:

1. Installs `~/.copilot/agents/goal-system.agent.md`.
2. Installs `~/.copilot/hooks/goal-system-vscode.json`.
3. Reuses the same package under `~/.copilot/extensions/goal-system/`, including `goalctl`.

The installer preserves existing settings and writes backups before changing JSON, JSONC, or Markdown files. Config backups keep the original file permissions, and newly created config files default to owner-only permissions.
Copilot CLI `settings.json` may contain comments and trailing commas; the installer accepts it and keeps comments outside the exact config subtree it updates.
If `settings.json` is malformed or is not a JSON object, the installer preserves the original as an `*.invalid-backup-*` file, recreates a clean JSON object, and then applies the goal-system entries.
Current recommended installs use local hooks, direct tools, the MCP stdio server, and `goalctl`. MCP is an additional goal API surface; `goalctl` remains the recovery fallback when a host hides or disables tools.
During updates, it recognizes existing goal hooks written with `~`, `$HOME`, `$COPILOT_HOME`, absolute paths, or wrapper commands. If a composite hook already runs `goal-context.sh`, the installer keeps that hook and avoids adding a duplicate direct goal hook.
During updates, the installer prepares a fresh runtime and production dependencies in a temporary directory before replacing the installed runtime, so failed dependency installs leave the previous runtime in place.

Run a local host health check any time the system feels off:

```bash
npm run doctor
```

Use `npm run doctor -- --target all` after installing all local surfaces.

Repository-level hook config is optional. Copy `.github/hooks/goal-system.json` into a repository if you want the same lifecycle hooks committed with a project.

## Source and releases

The root package is the single editable source for the goal-system runtime, hook, skill, tests, and documentation.

The VS Code extension generates `vscode-extension/resources/goal-system/` during packaging. That directory is a build artifact and is ignored by Git, so there is no second runtime source to keep in sync.

Marketplace releases are packaged snapshots. A GitHub commit does not update installed Marketplace copies by itself; a new extension version must be published. This repository includes `.github/workflows/publish-vscode.yml` so tagged or manually dispatched releases can package and publish the VSIX from GitHub when the `VSCE_PAT` secret is configured.

Updating the VS Code extension is not enough by itself because Copilot reads files from `~/.copilot/`. The extension compares its bundled version with the installed local runtime and prompts you to run the installer when local files are stale.

## How it works

```text
User prompt
  -> goal skill explains the execution contract
  -> shared goal core owns persisted state, validation, and summaries
  -> CLI adapter exposes SDK tools and CLI hooks
  -> MCP adapter exposes stdio tools from ~/.copilot/mcp-config.json
  -> VS Code Chat adapter exposes direct VS Code tools, goalctl fallback, and VS Code hooks
  -> tests verify the state machine without a live Copilot session
```

State lives under:

```text
~/.copilot/session-state/goal-system/
~/.copilot/session-state/<session-id>/goal-state.json
```

The duplicated state is intentional. It gives the system same-session lookup, same-directory continuation, and compact snapshots after context loss.

## Verify locally

```bash
npm ci
npm run verify
```

This runs:

- Node syntax checks
- shell syntax checks
- JSON validation
- goal-state unit tests
- hook smoke tests

Run the fixture check:

```bash
cd tests/fixtures/sample-goal-project
npm test
```

Expected result: fail before a goal session fixes it. The runtime E2E prompt uses the fixture to prove Copilot inspected, fixed, verified, updated the goal, and closed only with evidence.

## Docs

| Document | Purpose |
|----------|---------|
| [Install guide](https://gabrimatic.github.io/copilot-goal-system/reference/installation/) | Install, update, uninstall, and troubleshoot setup. |
| [VS Code Chat](https://gabrimatic.github.io/copilot-goal-system/product/vscode-chat/) | Preview adapter details, installed files, and current limits. |
| [Architecture](https://gabrimatic.github.io/copilot-goal-system/reference/architecture/) | State model, hooks, tools, and lifecycle rules. |
| [Requirements](https://gabrimatic.github.io/copilot-goal-system/reference/requirements/) | Goal-system contract and completion gates. |
| [Runtime E2E review](https://gabrimatic.github.io/copilot-goal-system/operations/runtime-e2e-review/) | Manual checklist for a live Copilot session. |
| [Portability](https://gabrimatic.github.io/copilot-goal-system/product/portability/) | Why the stable release is Copilot-first and what other CLIs would need. |
| [Support](SUPPORT.md) | Where to report issues and what diagnostics to include. |

## Project layout

```text
.
├── extension.mjs                         # Copilot SDK extension entrypoint
├── lib/goal-core.mjs                     # Goal state, validation, formatting, storage
├── adapters/mcp/server.mjs               # MCP stdio server for Copilot CLI and compatible clients
├── adapters/vscode-chat                  # VS Code hooks and custom agent
├── bin/goalctl.mjs                       # Local goal command fallback
├── hooks/goal-context.sh                 # CLI lifecycle hook helper
├── skills/goal/SKILL.md                  # Goal-mode instruction contract
├── instructions/copilot-instructions.goal-snippet.md
├── scripts/install.mjs                   # Installer implementation
├── scripts/install.sh                    # Shell installer wrapper
├── tests/*.test.mjs                      # Local state and hook tests
└── tests/fixtures/sample-goal-project    # Runtime E2E fixture
```

## Development

```bash
npm ci
npm run verify
```

Run one test file:

```bash
node --test tests/goal-core.test.mjs
node --test tests/goal-hook.test.mjs
```

Manual install into a temporary home:

```bash
tmp_home="$(mktemp -d)"
HOME="$tmp_home" ./install.sh
find "$tmp_home/.copilot" -maxdepth 4 -type f | sort
rm -rf "$tmp_home"
```

## Compatibility

This release supports:

- GitHub Copilot CLI: stable strict mode
- GitHub Copilot CLI MCP: local stdio `goalSystem` server in `~/.copilot/mcp-config.json`
- VS Code Copilot Chat: preview strict mode through VS Code agent hooks and direct VS Code goal tools

VS Code agent hooks and language model tools are VS Code extension surfaces. VS Code shows a confirmation dialog for extension-contributed language model tools; choose Always Allow for the goal tools if you want the smoothest loop. If an organization disables hooks or extension tools, the VS Code Chat adapter falls back to hook context plus the local `goalctl` command, and cannot force tool use by itself.

Other coding CLIs and model-runtime wrappers need a separate adapter before this can be called stable outside Copilot.

## License

[MIT License](LICENSE)
