# Portability

This release is Copilot-first.

The core idea is portable: keep a persisted Active Goal outside chat memory, inject compact reminders at lifecycle boundaries, deny drift, isolate subagents, and refuse completion without proof.

The implementation is not automatically portable because every CLI exposes different hooks, tools, settings, and subagent metadata.

## Required primitives

Any adapter needs these primitives:

| Primitive | Why it matters |
|-----------|----------------|
| User-triggered skill or slash command | Goal mode must stay manual. |
| Local persistent tool state | Goal state must survive compaction and resume. |
| Custom tools | The model needs explicit `status`, `open`, `update`, and `close` operations. |
| Pre-tool decision hook | Drift blocking needs a way to deny stale tool calls. |
| Prompt/session hooks | Continuation needs compact context injection. |
| Stop hook | Open goals need a way to block premature turn completion. |
| Subagent lifecycle metadata | Subagents must be excluded from goal ownership. |

## GitHub Copilot CLI

Supported by this project.

Copilot provides the surfaces this implementation uses:

- skills
- SDK extension tools
- user prompt/session hooks
- pre-tool and post-tool hooks
- stop hooks
- subagent hooks
- local settings

## Model-runtime wrappers

Not stable as a generic target.

Model runtimes are not agent shells with standardized lifecycle hooks. A specific runtime-backed CLI can support this pattern only if that CLI exposes the required primitives.

## Other terminal agents

Adapter needed.

If the agent supports MCP tools, hooks, and stable subagent metadata, the state machine can be reused. If it only supports prompts, the system becomes guidance rather than enforcement.
