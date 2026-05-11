# Local Verification

Run local verification before changing the installer, hook behavior, goal state, or completion gates.

## Static checks

```bash
npm run check
```

Covered:

- `node --check extension.mjs`
- `node --check lib/goal-core.mjs`
- `node --check adapters/vscode-chat/hook-runner.mjs`
- `node --check adapters/vscode-chat/mcp-server.mjs`
- `node --check scripts/install.mjs`
- shell syntax checks
- JSON validation for manifests and hook config

## Test suite

```bash
npm test
```

Covered:

- session ID sanitization
- activation prompt trimming
- slash-command `/goal` activation detection
- sensitive value redaction
- append-safe evidence merging
- intentional clearing of `remaining` and `blockers`
- refusal of weak completion evidence
- unresolved discovered issue blocking
- evidence-backed issue resolutions for renamed, merged, duplicate, superseded, or clearer-worded issues
- rejection of wildcard, target-only, or unevidenced issue-resolution claims
- closed terminal blocked-goal handling
- multi-session and multi-directory state isolation
- same-directory ambiguity detection
- same-directory continuation across resumed copies of the same goal
- compact prompt notes
- no raw history leakage in summaries
- hook quiet exit with no goal
- subagentStart boundary-only context
- agentStop blocking while a goal remains open
- agentStop ignoring terminal blocked goals
- preCompact snapshot side effect
- drift blocking helper behavior
- VS Code Chat hook output shape
- VS Code Chat prompt activation and continuation
- VS Code Chat stop blocking
- VS Code Chat persisted drift tracking
- VS Code Chat installer MCP merge behavior
- VS Code extension runtime update-state detection

## Fixture sanity check

```bash
cd tests/fixtures/sample-goal-project
npm test
```

Expected result: fail before an agent fixes it.

The failure is intentional. It proves the runtime E2E prompt is asking Copilot to do real work, not recite hardcoded facts.
