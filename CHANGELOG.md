# Changelog

## 1.1.7

- Normalizes Copilot CLI goal hook installs so `~`, `$HOME`, absolute, and wrapper-based `goal-context.sh` commands do not stack duplicate goal hooks.
- Preserves composite user hooks that already include `goal-context.sh`, such as merge helpers that also inject system context.
- Extends VS Code status checks to detect disabled CLI hooks, duplicate goal hooks, and stale drift hooks instead of reporting a misleading clean install.
- Adds regression coverage for duplicate direct hooks, composite hook preservation, stale drift hook reporting, and flexible hook command detection.

## 1.1.6

- Makes drift recovery non-deadlocking by default: critical drift now injects a recovery reminder while allowing the tool call, with hard denial left behind an explicit `GOAL_SYSTEM_HARD_DRIFT_BLOCK=1` opt-in.
- Resets drift accounting at each new user turn so stale tool history from an older turn cannot permanently lock a session.
- Removes stale goal-system `preToolUse` and `postToolUse` hooks from Copilot CLI settings during install or update.
- Updates the goal skill, docs, and regression tests for the recoverable drift contract.

## 1.1.5

- Fixes `/goal` slash-command activation detection so adapters that rely on shared activation logic create persisted goals correctly.
- Makes VS Code Chat persist a draft goal on explicit `/goal` prompts and load one unambiguous same-directory goal on explicit continuation.
- Registers the VS Code Chat `UserPromptSubmit` hook in installed hook config and status checks.
- Replaces installed runtime snapshots during updates so stale files removed from newer releases do not remain active.
- Writes compact snapshots as both readable text and machine-readable JSON.
- Strengthens release checks for lockfile version drift and changelog coverage.

## 1.1.4

- Strengthens stop-time continuation with a hard directive to reload status, continue work, update state, and close only with evidence.
- Treats alternate stop payloads such as `finishReason`, `completionReason`, and `terminationReason` as stop attempts.
- Reuses the same stop-continuation contract across CLI hooks and the VS Code Chat hook adapter.

## 1.1.3

- Publishes the VS Code extension automatically from GitHub Actions when a `v*` tag is pushed.
- Fails the publish workflow clearly when the Marketplace token is missing instead of silently packaging without publishing.
- Documents the `VSCE_PAT` setup and tag-based publish flow.

## 1.1.2

- Treats empty Copilot `settings.json` and VS Code `mcp.json` files as empty objects during install or update.
- Keeps malformed non-empty JSON protected: the installer still refuses to overwrite it.

## 1.1.1

- Adds evidence-backed `issueResolutions` for renamed, merged, duplicate, superseded, or clearer-worded discovered issues.
- Rejects wildcard, target-only, or unevidenced issue-resolution entries during completion.
- Prompts in VS Code when extension updates leave `~/.copilot/extensions/goal-system/` stale.
- Updates status reporting, docs, and tests for runtime update checks.

## 1.1.0

- Adds a VS Code Copilot Chat preview adapter with custom agent, VS Code lifecycle hooks, and local MCP goal tools.
- Adds `--target cli`, `--target vscode-chat`, and `--target all` installer modes.
- Adds persisted VS Code Chat drift tracking through shared goal history.
- Adds VS Code Chat install, hook, and MCP tests.
- Updates documentation for CLI stable mode and VS Code Chat preview mode.

## 1.0.2

- Adds a compact VS Code status bar item for setup state and quick status access.
- Adds an explicit setup walkthrough command and routes first-run onboarding through it.
- Renames Command Palette entries to shorter, clearer labels.
- Reduces repeated setup notifications and adds settings for first-run prompts and status bar visibility.

## 1.0.1

- Removes the committed VS Code bundle copy. The root package is now the only editable goal-system source, and the VSIX bundle is generated during package and publish.
- Adds release checks that keep root and VS Code extension versions aligned.
- Adds GitHub Actions publishing support for Marketplace releases from the repository.
- Improves the VS Code extension first-run setup prompt, Marketplace metadata, and documentation.

## 1.0.0

Initial public release.

- Adds persisted Active Goal state for GitHub Copilot CLI.
- Adds `goal_system_open`, `goal_system_status`, `goal_system_update`, and `goal_system_close`.
- Adds drift warnings and drift blocking when goal state is stale.
- Adds CLI hooks for session context, compaction snapshots, stop-time blocking, tool-failure recovery, and subagent boundaries.
- Adds a goal skill, global instruction snippet, installer, tests, docs, and runtime E2E fixture.
