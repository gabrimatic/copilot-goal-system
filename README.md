# Copilot Goal System

[![CI](https://github.com/gabrimatic/copilot-goal-system/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrimatic/copilot-goal-system/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Copilot CLI](https://img.shields.io/badge/GitHub_Copilot_CLI-supported-blue)](https://docs.github.com/copilot)
[![VS Code Chat](https://img.shields.io/badge/VS_Code_Copilot_Chat-preview-orange)](docs/VSCODE_CHAT.md)

Manual goal mode for GitHub Copilot CLI and VS Code Copilot Chat.

Copilot Goal System gives long-running Copilot sessions a persisted Active Goal, strict progress checkpoints, subagent boundaries, and proof-based completion. It is for people who want an agent to keep working through compaction, tool drift, subagents, multiple parallel sessions, and messy multi-step tasks without silently forgetting what done means.

[Quick start](#quick-start) · [What it adds](#what-it-adds) · [How it works](#how-it-works) · [Docs](#docs) · [Security](./SECURITY.md)

---

## Quick start

Runtime: **Node.js >= 20** and either **GitHub Copilot CLI** or **VS Code Copilot Chat**.

### VS Code

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gabrimatic.copilot-goal-system).

After VS Code installs the extension, run:

```text
Copilot Goal System: Install Recommended Setup
```

The Marketplace **Install** button installs the VS Code wrapper. The command above installs the local goal system for the current OS user:

- Copilot CLI stable adapter
- VS Code Copilot Chat preview adapter
- local MCP goal tools
- lifecycle hooks
- the Goal System custom agent

After extension updates, VS Code checks whether `~/.copilot/extensions/goal-system/` is older than the bundled runtime. If it is stale, the status bar switches to `Goal Update` and VS Code prompts you to update the local Copilot files.

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

`./install.sh` installs the Copilot CLI adapter by default. Use `./install.sh --target all` to install both CLI and VS Code Chat adapters.

For CLI, restart Copilot CLI, then run:

```text
/skills reload
/env
```

For VS Code Chat, reload VS Code or run `MCP: Reset Cached Tools`, then select the `Goal System` custom agent in Copilot Chat.

Start a goal in either surface:

```text
/goal
Make this project pass its test suite. Inspect first, fix every in-scope issue, verify with real evidence, and close only after the completion audit passes.
```

## What it adds

| Surface | Purpose |
|---------|---------|
| `goal_system_open` | Create or replace the persisted Active Goal. |
| `goal_system_status` | Reload authoritative goal state after resume, compaction, or uncertainty. |
| `goal_system_update` | Record inspected facts, discovered issues, issue resolutions, resolved work, verification, blockers, and remaining work. |
| `goal_system_close` | Close as complete, blocked, or cancelled. Completion is refused without proof. |
| Copilot hooks | Restore goal context, create compact snapshots, block premature stop, and isolate subagents. |
| VS Code Chat hooks | Inject session context, create compact snapshots, block premature stop, deny drift, and isolate subagents in Copilot Chat. |
| Local MCP server | Exposes the same goal tools to VS Code Copilot Chat. |
| Goal skill | Gives Copilot the behavior contract for goal-mode execution. |
| Goal System custom agent | Gives VS Code Chat a goal-focused agent entrypoint. |

Default behavior is strict:

- Goal mode is **manual**. Normal prompts do not become goals.
- Goal state is **main-session only**. Subagents cannot open, update, read, or close goals.
- Same-directory sessions are **isolated**. Automatic continuation happens only when exactly one open same-directory goal exists.
- The remaining queue is **dynamic**. Newly discovered in-scope issues are added to the goal and must be resolved before completion.
- Discovered issues can be **renamed, merged, deduplicated, superseded, or resolved under clearer wording** only with evidence-backed `issueResolutions`.
- Completion requires **inspection evidence, validation proof, verification results, requirement coverage, no remaining work, no blockers, resolved or evidence-covered discovered issues, and a completion audit**.
- Tool drift is controlled. After three non-goal tool calls without `goal_system_update`, Copilot gets a warning. After five, non-goal tools are denied until the goal is updated.
- Stop hooks are blocked while an open goal remains active, with a hard continuation directive that tells Copilot to reload status, continue work, update persisted state, and close only with evidence.

## Install details

`./install.sh` supports three targets:

```bash
./install.sh --target cli
./install.sh --target vscode-chat
./install.sh --target all
```

The default target is `cli`.

For Copilot CLI, the installer:

1. Copies this package to `~/.copilot/extensions/goal-system/`.
2. Installs production dependencies inside that extension directory.
3. Installs the goal skill at `~/.copilot/skills/goal/SKILL.md`.
4. Installs the hook helper at `~/.copilot/hooks/goal-context.sh` and merges hook entries into `~/.copilot/settings.json`.

For VS Code Copilot Chat, the installer:

1. Installs `~/.copilot/agents/goal-system.agent.md`.
2. Installs `~/.copilot/hooks/goal-system-vscode.json`.
3. Adds the `goalSystem` stdio MCP server to the VS Code user `mcp.json`.
4. Reuses the same package under `~/.copilot/extensions/goal-system/`.

The installer preserves existing settings and writes backups before changing JSON or Markdown files.

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
  -> VS Code Chat adapter exposes MCP tools and VS Code hooks
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

That test is supposed to fail before an agent fixes it. The runtime E2E prompt uses it to prove Copilot inspected, fixed, verified, updated the goal, and closed only with evidence.

## Docs

| Document | Purpose |
|----------|---------|
| [Install guide](docs/INSTALL.md) | Install, update, uninstall, and troubleshoot setup. |
| [VS Code Chat](docs/VSCODE_CHAT.md) | Preview adapter details, installed files, and current limits. |
| [Architecture](docs/ARCHITECTURE.md) | State model, hooks, tools, and lifecycle rules. |
| [Requirements](docs/requirements.md) | Goal-system contract and completion gates. |
| [Runtime E2E review](docs/e2e-review.md) | Manual checklist for a live Copilot session. |
| [Portability](docs/PORTABILITY.md) | Why the stable release is Copilot-first and what other CLIs would need. |
| [Support](SUPPORT.md) | Where to report issues and what diagnostics to include. |

## Project layout

```text
.
├── extension.mjs                         # Copilot SDK extension entrypoint
├── lib/goal-core.mjs                     # Goal state, validation, formatting, storage
├── adapters/vscode-chat                  # VS Code hooks, custom agent, MCP server
├── hooks/goal-context.sh                 # CLI lifecycle hook helper
├── skills/goal/SKILL.md                  # Goal-mode instruction contract
├── instructions/copilot-instructions.goal-snippet.md
├── scripts/install.mjs                   # Installer implementation
├── scripts/install.sh                    # Shell installer wrapper
├── tests/*.test.mjs                      # Local state and hook tests
├── tests/fixtures/sample-goal-project    # Runtime E2E fixture
└── docs/
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
- VS Code Copilot Chat: preview strict mode through VS Code agent hooks and MCP

VS Code agent hooks and agent plugins are Preview surfaces. If an organization disables hooks or MCP, the VS Code Chat adapter cannot enforce the full lifecycle.

Other coding CLIs and model-runtime wrappers need a separate adapter before this can be called stable outside Copilot.

## License

[MIT License](LICENSE)
