#!/usr/bin/env node
import {
  GoalStore,
  appendGoalHistory,
  buildDriftEnforcement,
  buildGoalPromptNote,
  countToolDrift,
  formatGoalSummary,
  isGoalSystemToolName,
  isOpenGoal,
  normalizeCwd,
  normalizeText,
  safeSessionId,
  shouldEnforceDrift,
  summarizeToolUse,
} from "../../lib/goal-core.mjs";

const DRIFT_WARN_THRESHOLD = 3;
const DRIFT_BLOCK_THRESHOLD = 5;

const SUBAGENT_BOUNDARY_NOTE =
  "Goal mode is main-session only. Do not use goal_system_* tools, do not open or close goals, and do not assume the active goal. Complete only your bounded delegated subtask and return real evidence to the main session.";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitContinue() {
  emit({ continue: true });
}

function emitSpecific(hookEventName, payload) {
  emit({ hookSpecificOutput: { hookEventName, ...payload } });
}

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalEventName(input = {}) {
  const raw = normalizeText(input.hookEventName || input.hook_event_name, 80);
  const lookup = {
    sessionstart: "SessionStart",
    userpromptsubmit: "UserPromptSubmit",
    userpromptsubmitted: "UserPromptSubmit",
    pretooluse: "PreToolUse",
    posttooluse: "PostToolUse",
    precompact: "PreCompact",
    subagentstart: "SubagentStart",
    subagentstop: "SubagentStop",
    stop: "Stop",
    agentstop: "Stop",
  };
  if (lookup[raw.toLowerCase()]) return lookup[raw.toLowerCase()];
  if ("trigger" in input) return "PreCompact";
  if ("tool_name" in input || "toolName" in input) return "tool_response" in input || "toolResult" in input ? "PostToolUse" : "PreToolUse";
  if ("agent_id" in input || "agentName" in input) return "stopReason" in input || "stop_reason" in input ? "SubagentStop" : "SubagentStart";
  if ("stopReason" in input || "stop_reason" in input || "stop_hook_active" in input) return "Stop";
  if ("prompt" in input) return "UserPromptSubmit";
  return "SessionStart";
}

function sessionContext(input = {}) {
  const sessionId = safeSessionId(input.sessionId || input.session_id);
  const cwd = normalizeCwd(input.cwd || input.workspace || input.workspaceFolder);
  return { sessionId, cwd };
}

function isSubagentToolEvent(input = {}) {
  return Boolean(input.agent_id || input.parentSessionId || input.parent_session_id || input.isSubagent || input.subagent);
}

function stopBlockReason(goal) {
  return [
    "Active persisted goal is still open for this main session.",
    `Goal ID: ${goal.id || "unknown"}`,
    `Objective: ${goal.objective || "unknown until inspected"}`,
    `Remaining: ${(goal.remaining || []).slice(0, 4).join(" | ") || "none recorded"}`,
    `Blockers: ${(goal.blockers || []).slice(0, 3).join(" | ") || "none recorded"}`,
    "",
    "Do not end the turn yet. Call goal_system_status, continue the remaining work, or close only after the required inspection evidence, resolved issues, verification results, requirement coverage, and completion audit are recorded. If truly blocked, close as blocked with exact blocker evidence.",
  ].join("\n");
}

function emptySessionContextNote(sessionId, cwd) {
  return [
    "Goal System for VS Code Chat is available for this main session.",
    `sessionId: ${sessionId}`,
    `cwd: ${cwd}`,
    "When the user explicitly starts goal mode, call goal_system_open with these exact values. For active goals, use goal_system_status before continuing or closing. Subagents must not use goal tools.",
  ].join("\n");
}

async function loadOpenGoal(store, sessionId, cwd) {
  const record = await store.loadGoalRecord(sessionId, cwd);
  return record && isOpenGoal(record.goal) ? record.goal : null;
}

async function main() {
  const input = await readInput();
  if (!input) return;

  const eventName = canonicalEventName(input);
  const { sessionId, cwd } = sessionContext(input);

  if (eventName === "SubagentStart") {
    emitSpecific("SubagentStart", { additionalContext: SUBAGENT_BOUNDARY_NOTE });
    return;
  }

  const store = new GoalStore();
  await store.init();
  const activeGoal = await loadOpenGoal(store, sessionId, cwd);

  if (!activeGoal) {
    if (eventName === "SessionStart") {
      emitSpecific("SessionStart", { additionalContext: emptySessionContextNote(sessionId, cwd) });
    }
    return;
  }

  if (eventName === "SessionStart") {
    emitSpecific("SessionStart", { additionalContext: `${buildGoalPromptNote(activeGoal)}\n\n${emptySessionContextNote(sessionId, cwd)}` });
    return;
  }

  if (eventName === "PreCompact") {
    await store.writeCompactSnapshot(sessionId, cwd, activeGoal);
    emitContinue();
    return;
  }

  if (eventName === "Stop") {
    if (input.stop_hook_active === true || input.stopHookActive === true) {
      emitContinue();
      return;
    }
    emitSpecific("Stop", { decision: "block", reason: stopBlockReason(activeGoal) });
    return;
  }

  if (eventName === "SubagentStop") {
    emitContinue();
    return;
  }

  if (eventName === "PreToolUse") {
    const toolName = normalizeText(input.tool_name || input.toolName, 180);
    if (isSubagentToolEvent(input) || isGoalSystemToolName(toolName)) {
      emitContinue();
      return;
    }

    const drift = countToolDrift(activeGoal);
    if (
      shouldEnforceDrift({
        hasActiveGoal: true,
        toolName,
        driftCount: drift,
        threshold: DRIFT_BLOCK_THRESHOLD,
        isSubagent: false,
      })
    ) {
      const message = buildDriftEnforcement(drift, DRIFT_BLOCK_THRESHOLD);
      emitSpecific("PreToolUse", {
        permissionDecision: "deny",
        permissionDecisionReason: message,
        additionalContext: message,
      });
      return;
    }

    if (drift >= DRIFT_WARN_THRESHOLD) {
      emitSpecific("PreToolUse", {
        permissionDecision: "allow",
        additionalContext: `Goal-state drift warning: ${drift} tool calls have run since the last goal_system_update. Update the persisted goal before this becomes blocked.`,
      });
      return;
    }

    emitContinue();
    return;
  }

  if (eventName === "PostToolUse") {
    const toolName = normalizeText(input.tool_name || input.toolName, 180);
    if (isSubagentToolEvent(input) || isGoalSystemToolName(toolName)) {
      emitContinue();
      return;
    }

    const note = summarizeToolUse(input);
    if (note) {
      const nextGoal = appendGoalHistory(activeGoal, "tool", note);
      await store.persistGoalRecord(sessionId, cwd, nextGoal);
    }
    emitContinue();
    return;
  }

  if (eventName === "UserPromptSubmit") {
    emit({ continue: true, systemMessage: formatGoalSummary(activeGoal, { includeHistory: false }) });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
