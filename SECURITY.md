# Security Policy

## Security model

Copilot Goal System stores local goal state and injects compact context into GitHub Copilot CLI and VS Code Copilot Chat sessions. It does not send telemetry, analytics, prompts, or goal state to a service owned by this project.

Network behavior is limited to install-time dependency retrieval through `npm`, and whatever GitHub Copilot or VS Code Copilot Chat does in your environment.

## Local data

Goal state is stored under:

```text
~/.copilot/session-state/goal-system/
~/.copilot/session-state/<session-id>/goal-state.json
```

The state model redacts common secrets, emails, tokens, passwords, API keys, bearer values, GitHub tokens, provider-style secret keys, and phone-number-like strings before storing prompt previews and tool history. Treat the state directory as local session data, not as a public artifact.

## Permissions

| Surface | Permission | Scope |
|---------|------------|-------|
| Installer | Filesystem writes | `~/.copilot/extensions/goal-system`, `~/.copilot/skills/goal`, `~/.copilot/agents`, `~/.copilot/hooks`, `~/.copilot/settings.json`, `~/.copilot/copilot-instructions.md`, VS Code user `mcp.json` |
| Extension | Filesystem writes | Local install files and goal state under `~/.copilot/session-state/goal-system` |
| Hook | Filesystem reads/writes | Reads goal state, writes compact snapshots and tool-history summaries |
| MCP server | Filesystem reads/writes | Reads and updates local goal state for VS Code Chat tool calls |
| npm | Network | Installs package dependencies during setup |

## Trust boundaries

| Boundary | Trust level | Notes |
|----------|-------------|-------|
| User prompt | Untrusted input | Stored only as redacted hash/preview. |
| Tool summaries | Untrusted input | Redacted and truncated before persistence. |
| `~/.copilot/settings.json` | User-controlled | Installer merges goal hooks and preserves existing settings. |
| VS Code user `mcp.json` | User-controlled | Installer merges the `goalSystem` server and preserves existing servers. |
| Subagents | Untrusted for goal state | Subagents receive boundary instructions and goal tools reject likely subagent invocations. |
| Copilot SDK | Trusted dependency | Pinned in `package-lock.json`. |
| MCP SDK | Trusted dependency | Pinned in `package-lock.json`. |

## Vulnerability reporting

Report vulnerabilities responsibly:

1. Do not open a public issue.
2. Use GitHub private vulnerability reporting: <https://github.com/gabrimatic/copilot-goal-system/security/advisories/new>
3. Include reproduction steps, impact, and affected version.

Expect acknowledgment within 48 hours.

## Out of scope

- Issues in GitHub Copilot CLI or VS Code Copilot Chat itself.
- Issues requiring local filesystem access to a user's account.
- Prompt injection that only affects the agent's normal natural-language output.
- Dependency vulnerabilities without a demonstrated exploit path through this package.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
