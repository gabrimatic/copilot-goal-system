# Copilot Goal System

[![CI](https://github.com/gabrimatic/copilot-goal-system/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrimatic/copilot-goal-system/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Copilot CLI](https://img.shields.io/badge/GitHub_Copilot_CLI-supported-blue)](https://docs.github.com/copilot)

Manual goal mode for GitHub Copilot CLI.

Copilot Goal System gives long-running Copilot sessions a persisted Active Goal, strict progress checkpoints, subagent boundaries, and proof-based completion. It is for people who want an agent to keep working through compaction, tool drift, subagents, multiple parallel sessions, and messy multi-step tasks without silently forgetting what done means.

[Quick start](#quick-start) · [What it adds](#what-it-adds) · [How it works](#how-it-works) · [Docs](#docs) · [Security](./SECURITY.md)

---

## Quick start

Runtime: **Node.js >= 20** and **GitHub Copilot CLI**.

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

Restart Copilot CLI, then run:

```text
/skills reload
/env
```

Start a goal:

```text
/goal
Make this project pass its test suite. Inspect first, fix every in-scope issue, verify with real evidence, and close only after the completion audit passes.
```

## What it adds

| Surface | Purpose |
|---------|---------|
| `goal_system_open` | Create or replace the persisted Active Goal. |
| `goal_system_status` | Reload authoritative goal state after resume, compaction, or uncertainty. |
| `goal_system_update` | Record inspected facts, discovered issues, resolved work, verification, blockers, and remaining work. |
| `goal_system_close` | Close as complete, blocked, or cancelled. Completion is refused without proof. |
| Copilot hooks | Restore goal context, create compact snapshots, block premature stop, and isolate subagents. |
| Goal skill | Gives Copilot the behavior contract for goal-mode execution. |

Default behavior is strict:

- Goal mode is **manual**. Normal prompts do not become goals.
- Goal state is **main-session only**. Subagents cannot open, update, read, or close goals.
- Same-directory sessions are **isolated**. Automatic continuation happens only when exactly one open same-directory goal exists.
- The remaining queue is **dynamic**. Newly discovered in-scope issues are added to the goal and must be resolved before completion.
- Completion requires **inspection evidence, validation proof, verification results, requirement coverage, no remaining work, no blockers, resolved discovered issues, and a completion audit**.
- Tool drift is controlled. After three non-goal tool calls without `goal_system_update`, Copilot gets a warning. After five, non-goal tools are denied until the goal is updated.
- `agentStop` is blocked while an open goal remains active.

## Install details

`./install.sh` does four things:

1. Copies this package to `~/.copilot/extensions/goal-system/`.
2. Installs production dependencies inside that extension directory.
3. Installs the goal skill at `~/.copilot/skills/goal/SKILL.md`.
4. Installs the hook helper at `~/.copilot/hooks/goal-context.sh` and merges hook entries into `~/.copilot/settings.json`.

The installer preserves existing settings and appends only missing goal-system hook entries.

Repository-level hook config is optional. Copy `.github/hooks/goal-system.json` into a repository if you want the same lifecycle hooks committed with a project.

## How it works

```text
User prompt
  -> goal skill explains the execution contract
  -> SDK extension owns persisted goal state and goal_system_* tools
  -> CLI hooks restore compact context and block unsafe lifecycle exits
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
| [Architecture](docs/ARCHITECTURE.md) | State model, hooks, tools, and lifecycle rules. |
| [Requirements](docs/requirements.md) | Goal-system contract and completion gates. |
| [Runtime E2E review](docs/e2e-review.md) | Manual checklist for a live Copilot session. |
| [Portability](docs/PORTABILITY.md) | Why the stable release is Copilot-first and what other CLIs would need. |

## Project layout

```text
.
├── extension.mjs                         # Copilot SDK extension entrypoint
├── lib/goal-core.mjs                     # Goal state, validation, formatting, storage
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

This release supports GitHub Copilot CLI. Other tools can adopt the same design only if they provide all required primitives:

- user-triggered skills or slash commands
- persistent local tool state
- pre-tool decision hooks
- prompt/session lifecycle hooks
- stop hooks
- subagent lifecycle metadata

Other coding CLIs and model-runtime wrappers need a separate adapter before this can be called stable outside Copilot.

## License

[MIT License](LICENSE)
