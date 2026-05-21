#!/usr/bin/env node
import {
  ACTIVATION_REGEX,
  CONTINUE_REGEX,
  GoalStore,
  appendGoalHistory,
  buildDriftEnforcement,
  buildGoalPromptNote,
  buildStopContinuationDirective,
  countToolDrift,
  createGoalRecord,
  formatGoalSummary,
  isGoalSystemToolName,
  isOpenGoal,
  normalizeCwd,
  normalizeText,
  safeSessionId,
  shouldEnforceDrift,
  summarizeToolUse,
  trimmedPromptObjective,
} from "../../lib/goal-core.mjs";

const DRIFT_WARN_THRESHOLD = 3;
const DRIFT_BLOCK_THRESHOLD = 5;
const HARD_DRIFT_BLOCK = process.env.GOAL_SYSTEM_HARD_DRIFT_BLOCK === "1";

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
  const hasStopSignal = [
    "stopReason",
    "stop_reason",
    "finishReason",
    "finish_reason",
    "completionReason",
    "completion_reason",
    "terminationReason",
    "termination_reason",
    "stop_hook_active",
    "stopHookActive",
  ].some((key) => key in input);
  if ("agent_id" in input || "agentName" in input) return hasStopSignal ? "SubagentStop" : "SubagentStart";
  if (hasStopSignal) return "Stop";
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
  return buildStopContinuationDirective(goal);
}

function emptySessionContextNote(sessionId, cwd) {
  return [
    "Goal System for VS Code Chat is available for this main session.",
    `sessionId: ${sessionId}`,
    `cwd: ${cwd}`,
    "When the prompt explicitly starts goal mode, call goal_system_open with these exact values. For active goals, use goal_system_status before continuing or closing. Subagents must not use goal tools.",
  ].join("\n");
}

function draftActivationMessage(goal) {
  return [
    "A persisted draft goal was created for this VS Code Chat main session.",
    `Goal ID: ${goal.id || "unknown"}`,
    `Objective: ${goal.objective || "unknown until inspected"}`,
    "Inspect the real environment before treating any detail as fact, then call goal_system_update with verified facts before doing substantive work.",
    "Do not answer with only an acknowledgment. Continue the real task and close only after proof.",
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
    if (eventName === "UserPromptSubmit") {
      const prompt = normalizeText(input.prompt, 10000);
      const isContinuePrompt = CONTINUE_REGEX.test(prompt);
      if (ACTIVATION_REGEX.test(prompt) && !isContinuePrompt) {
        const draftGoal = createGoalRecord(
          {
            objective: trimmedPromptObjective(prompt),
            requirements: ["Inspect the real environment before treating any unverified detail as fact."],
            doneSoFar: ["Draft goal record created from the explicit goal-mode prompt."],
            remaining: [
              "Inspect the real environment and replace draft fields with verified facts.",
              "Execute the goal, record discovered issues, fix them, verify with evidence, and close only after audit.",
            ],
            completionStatus: "draft",
          },
          sessionId,
          cwd,
          {
            sourcePrompt: prompt,
            historyNote: "VS Code Chat draft goal created automatically from explicit activation prompt",
          }
        );
        const persisted = await store.persistGoalRecord(sessionId, cwd, draftGoal);
        store.auditLog("vscode_draft_auto", { sid: sessionId, id: persisted.id, promptHash: persisted.sourcePromptHash });
        emit({ continue: true, systemMessage: draftActivationMessage(persisted) });
        return;
      }

      if (!isContinuePrompt) return;

      const workspaceCandidates = await store.loadWorkspaceGoalCandidates(cwd);
      const { record: workspaceGoal, openCount } = store.pickSingleOpenWorkspaceGoal(workspaceCandidates);
      if (workspaceGoal) {
        const hydrated = await store.persistGoalRecord(sessionId, cwd, workspaceGoal.goal);
        emit({
          continue: true,
          systemMessage: `${buildGoalPromptNote(hydrated)}\n\nA single unambiguous same-directory goal was loaded for continuation. Continue from persisted state, not memory.`,
        });
        return;
      }
      if (openCount > 1) {
        emit({
          continue: true,
          systemMessage:
            "Multiple active goals exist for this working directory across sessions. Do not guess which one to continue. Ask for the intended session or goal ID.",
        });
        return;
      }
      emit({
        continue: true,
        systemMessage:
          "No persisted active goal was found for this working directory. Do not pretend a goal exists. Reconstruct from supplied artifacts or ask for the missing objective.",
      });
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
        hardBlockDrift: HARD_DRIFT_BLOCK,
        canRecoverWithGoalUpdate: true,
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

    if (drift >= DRIFT_BLOCK_THRESHOLD) {
      const message = buildDriftEnforcement(drift, DRIFT_BLOCK_THRESHOLD);
      emitSpecific("PreToolUse", {
        permissionDecision: "allow",
        additionalContext: message,
      });
      return;
    }

    if (drift >= DRIFT_WARN_THRESHOLD) {
      emitSpecific("PreToolUse", {
        permissionDecision: "allow",
        additionalContext: `Goal-state drift warning: ${drift} tool calls have run since the last goal_system_update. Update the persisted goal at the next useful checkpoint.`,
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
    const nextGoal = appendGoalHistory(activeGoal, "turn", "User prompt submitted");
    const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
    emit({ continue: true, systemMessage: formatGoalSummary(persisted, { includeHistory: false }) });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
