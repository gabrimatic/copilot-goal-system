# Changelog

## 1.1.15

- Fixes Linux CI doctor tests by isolating fake-home `XDG_CONFIG_HOME` paths before release.

## 1.1.14

- Fixes the installer and release helper error paths so piped CI output cannot lose the real failure message before exit.
- Stabilizes corrupt-config installer regression tests by matching captured process output instead of Node's runtime-specific `execFile` wrapper message.
- Serializes the Node test runner so installer and doctor tests that spawn local processes cannot race each other in CI.
- Adds release verification coverage for the GitHub runner shape that exposed the flake: Linux x64, Node 20, and CI-mode environment variables.

## 1.1.13

- Installs `jq` in CI and Marketplace publish workflows so Linux release checks exercise the CLI hook helper instead of silently skipping it.
- Documents `jq` as a CLI hook dependency alongside the bash shell requirement.
- Reports missing `jq` in doctor output instead of leaving CLI hook parsing as an invisible no-op.

## 1.1.12

- Makes release verification deterministic by avoiding repeated live `npm ci` calls inside installer and doctor regression tests while keeping explicit failed-update rollback coverage.
- Removes the `jq` requirement from `npm run check` so JSON validation runs through Node on every supported development host.
- Adds quieter, more cache-friendly production dependency installation flags for local runtime updates.
- Teaches `npm run doctor` the same `--vscode-mcp-config` override as the installer so custom VS Code profiles verify the path that was actually updated.

## 1.1.11

- Fixes the doctor JSONC regression test to use the platform-specific VS Code MCP config path, matching Linux CI and macOS local installs.

## 1.1.10

- Completes installer update hardening with shared Copilot profile-root resolution across install, doctor, and VS Code status/update paths.
- Refuses parseable but non-object config files before replacing the installed runtime.
- Uses the same runtime allowlist for local installs and VS Code Marketplace bundles so unrelated repository artifacts cannot leak into installed runtime snapshots.

## 1.1.9

- Accepts JSONC in Copilot CLI `settings.json`, Copilot CLI `mcp-config.json`, and VS Code profile `mcp.json` during install and doctor checks, matching Copilot CLI's documented config format.
- Preserves comments outside the exact updated config subtrees while merging goal hooks and MCP server entries.
- Makes runtime updates transactional by installing production dependencies in a temporary runtime before replacing the existing local runtime.
- Supports non-default `COPILOT_HOME` profiles in installer paths, hook commands, MCP server environment, and CLI hook state lookup.
- Adds regression coverage for JSONC install, JSONC doctor status, failed-update rollback, `COPILOT_HOME`, and VS Code MCP JSONC config so Marketplace-bundled installers cannot reject valid commented config again.

## 1.1.8

- Adds a standard Copilot CLI MCP fallback server at `~/.copilot/mcp-config.json` so `goal_system_*` tools can be available through normal MCP discovery as well as the SDK extension path.
- Adds `npm run doctor` for local host diagnostics across Copilot CLI, installed runtime files, lifecycle hooks, stale drift hooks, duplicate hook entries, CLI MCP loading, exact configured MCP self-tests, and VS Code MCP config.
- Injects `sessionId` and `cwd` into CLI hook context and creates a persisted draft goal from explicit CLI `/goal` prompts so MCP fallback tools can bootstrap a new goal when direct SDK tools are hidden.
- Recognizes Copilot CLI's MCP-prefixed tool names such as `goalSystem-goal_system_update` as goal tools, so recovery updates do not count as drift.
- Preflights target JSON files before copying runtime files and improves VS Code status wording for partial CLI-only or VS Code-only installs.

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
