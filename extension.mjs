import { joinSession } from "@github/copilot-sdk/extension";
import {
  ACTIVATION_REGEX,
  CONTINUE_REGEX,
  REPLACE_REGEX,
  GOAL_STATUSES,
  ISSUE_RESOLUTION_STATUSES,
  MUTABLE_GOAL_STATUSES,
  GoalStore,
  appendGoalHistory,
  appendPromptNote,
  buildDriftEnforcement,
  buildGoalPromptNote,
  createGoalRecord,
  formatGoalSummary,
  isGoalSystemToolName,
  isLikelySubagentInvocation,
  isOpenGoal,
  mergeGoal,
  normalizeCwd,
  normalizeText,
  nowIso,
  safeSessionId,
  shouldEnforceDrift,
  summarizeToolUse,
  trimmedPromptObjective,
  validateGoalCompletion,
} from "./lib/goal-core.mjs";

const HISTORY_SKIP_TOOLS = new Set([
  "report_intent",
]);

const FLUSH_INTERVAL_MS = 4000;
const MAX_PENDING_ENTRIES = 50;

const store = new GoalStore();
await store.init();

const sessionCwds = new Map();
const activeGoalSessions = new Set();
const pendingHistoryBySession = new Map();
const driftCountBySession = new Map();
let flushTimer = null;

const DRIFT_WARN_THRESHOLD = 3;
const DRIFT_BLOCK_THRESHOLD = 5;
const HARD_DRIFT_BLOCK = process.env.GOAL_SYSTEM_HARD_DRIFT_BLOCK === "1";

const SUBAGENT_BOUNDARY_NOTE =
  "Goal mode is main-session only. Subagents must not open, update, read, close, or infer goal state. Complete only the delegated subtask and return evidence to the main session.";

function invocationCwd(invocation = {}) {
  return invocation.cwd || invocation.workspace || invocation.workspaceFolder || process.cwd();
}

function setSessionCwd(sessionId, cwd) {
  const sid = safeSessionId(sessionId);
  if (!normalizeText(cwd, 2000)) {
    return getSessionCwd(sessionId, cwd);
  }
  const normalizedCwd = normalizeCwd(cwd);
  if (sid) sessionCwds.set(sid, normalizedCwd);
  return normalizedCwd;
}

function getSessionCwd(sessionId, fallbackCwd) {
  const sid = safeSessionId(sessionId);
  if (sid && sessionCwds.has(sid)) return sessionCwds.get(sid);
  return normalizeCwd(fallbackCwd);
}

function activateSessionIfOpen(sessionId, goal) {
  const sid = safeSessionId(sessionId);
  if (!sid) return;
  if (isOpenGoal(goal)) activeGoalSessions.add(sid);
  else activeGoalSessions.delete(sid);
}

async function loadCurrentOpenGoal(invocation, cwd) {
  const sessionCwd = getSessionCwd(invocation.sessionId, cwd);
  const loadedGoal = await store.loadGoalRecord(invocation.sessionId, sessionCwd);
  const activeGoal = loadedGoal && isOpenGoal(loadedGoal.goal) ? loadedGoal.goal : null;
  activateSessionIfOpen(invocation.sessionId, activeGoal);
  return { sessionCwd, loadedGoal, activeGoal };
}

async function persistAndTrack(invocation, cwd, goal) {
  const persisted = await store.persistGoalRecord(invocation.sessionId, cwd, goal);
  activateSessionIfOpen(invocation.sessionId, persisted);
  return persisted;
}

async function hydrateSessionGoal(invocation, cwd, goalRecord) {
  if (!goalRecord?.goal) return null;
  const persisted = await persistAndTrack(invocation, cwd, goalRecord.goal);
  return persisted;
}

async function flushPendingHistory(sessionId) {
  const sid = safeSessionId(sessionId);
  const entries = pendingHistoryBySession.get(sid);
  if (!entries || entries.length === 0) return;
  pendingHistoryBySession.delete(sid);

  const sessionCwd = getSessionCwd(sid);
  const loadedGoal = await store.loadGoalRecord(sid, sessionCwd);
  if (!loadedGoal || !isOpenGoal(loadedGoal.goal)) return;

  const history = Array.isArray(loadedGoal.goal.history) ? loadedGoal.goal.history.slice(-39) : [];
  for (const entry of entries.slice(-20)) history.push(entry);

  const nextGoal = { ...loadedGoal.goal, history: history.slice(-40) };
  await persistAndTrack({ sessionId: sid }, sessionCwd, nextGoal);
}

async function flushAllPending() {
  const sessionIds = [...pendingHistoryBySession.keys()];
  for (const sid of sessionIds) {
    try {
      await flushPendingHistory(sid);
    } catch (error) {
      store.auditLog("flush_error", { sid, error: error?.message || "unknown" });
    }
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushAllPending();
  }, FLUSH_INTERVAL_MS);
}

async function ensureFlushed(sessionId) {
  const sid = safeSessionId(sessionId);
  if (pendingHistoryBySession.has(sid)) await flushPendingHistory(sid);
}

function assertMainSessionTool(invocation) {
  if (isLikelySubagentInvocation(invocation)) {
    return {
      textResultForLlm: SUBAGENT_BOUNDARY_NOTE,
      resultType: "failure",
    };
  }
  return null;
}

function appendActivationInstructions(prompt) {
  return appendPromptNote(
    prompt,
    [
      "A persisted draft goal was created for this main session only.",
      "Do not answer with only 'goal-system loaded'. Inspect the real environment first, then call goal_system_update with verified facts before doing substantive work.",
      "This is execution mode when the prompt asks for execution: inspect, fix, verify, and prove. Do not keep the goal only in conversation memory.",
    ].join("\n")
  );
}

const goalToolProperties = {
  objective: { type: "string", description: "The verified goal objective." },
  requirements: { type: "array", items: { type: "string" }, description: "Explicit requirements extracted from the prompt." },
  scope: { type: "array", items: { type: "string" } },
  mustNotRegress: { type: "array", items: { type: "string" } },
  constraints: { type: "array", items: { type: "string" } },
  currentEnvironment: { type: "array", items: { type: "string" } },
  requiredTools: { type: "array", items: { type: "string" } },
  validationProof: { type: "array", items: { type: "string" } },
  verificationResults: { type: "array", items: { type: "string" } },
  requirementCoverage: { type: "array", items: { type: "string" } },
  inspectionEvidence: { type: "array", items: { type: "string" } },
  discoveredIssues: { type: "array", items: { type: "string" } },
  resolvedIssues: { type: "array", items: { type: "string" } },
  issueResolutions: {
    type: "array",
    description:
      "Evidence-backed coverage for discovered issues whose resolution wording differs from the original issue text. Use covers plus evidence instead of forcing literal resolvedIssues strings.",
    items: {
      type: "object",
      properties: {
        covers: {
          type: "array",
          items: { type: "string" },
          description: "Specific discovered issue references, IDs, or exact/substantial issue text. Wildcards are refused.",
        },
        issue: { type: "string", description: "Optional single discovered issue reference." },
        originalIssue: { type: "string", description: "Optional original discovered issue text." },
        target: { type: "string", description: "Optional target or broader issue. Does not count as original coverage by itself." },
        targetIssue: { type: "string", description: "Optional target or broader issue. Does not count as original coverage by itself." },
        status: { type: "string", enum: ISSUE_RESOLUTION_STATUSES },
        resolution: { type: "string", description: "Concrete fix, merge, duplicate, or rename explanation." },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Concrete proof for this issue resolution, such as tests, inspected files, or runtime checks.",
        },
      },
    },
  },
  doneSoFar: { type: "array", items: { type: "string" } },
  remaining: { type: "array", items: { type: "string" } },
  blockers: { type: "array", items: { type: "string" } },
  completionAudit: { type: "array", items: { type: "string" } },
  sourcePrompt: { type: "string", description: "Optional original prompt. Stored only as a redacted preview and hash." },
  historyNote: { type: "string" },
};

const session = await joinSession({
  hooks: {
    onSessionStart: async (input, invocation) => {
      if (isLikelySubagentInvocation(invocation)) {
        return { additionalContext: SUBAGENT_BOUNDARY_NOTE };
      }

      const sessionCwd = setSessionCwd(invocation.sessionId, input.cwd);
      const loadedGoal = await store.loadGoalRecord(invocation.sessionId, sessionCwd);
      if (!loadedGoal || !isOpenGoal(loadedGoal.goal)) {
        store.auditLog("session_start_no_goal", { sid: safeSessionId(invocation.sessionId) });
        return;
      }

      const goal = await hydrateSessionGoal(invocation, sessionCwd, loadedGoal);
      store.auditLog("session_resume", { sid: safeSessionId(invocation.sessionId), id: goal.id });
      return {
        additionalContext: buildGoalPromptNote(goal),
      };
    },

    onUserPromptSubmitted: async (input, invocation) => {
      const sessionCwd = setSessionCwd(invocation.sessionId, input.cwd);
      const prompt = normalizeText(input.prompt, 10000);
      if (isLikelySubagentInvocation(invocation)) {
        return { modifiedPrompt: appendPromptNote(prompt, SUBAGENT_BOUNDARY_NOTE) };
      }

      const { activeGoal } = await loadCurrentOpenGoal(invocation, sessionCwd);

      const isActivationPrompt = ACTIVATION_REGEX.test(prompt);
      const isContinuePrompt = CONTINUE_REGEX.test(prompt);
      const explicitlyReplaces = REPLACE_REGEX.test(prompt);

      if (!activeGoal && isActivationPrompt && !isContinuePrompt) {
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
          invocation.sessionId,
          sessionCwd,
          {
            sourcePrompt: prompt,
            historyNote: "Draft goal created automatically from explicit user activation prompt",
          }
        );
        const persisted = await persistAndTrack(invocation, sessionCwd, draftGoal);
        store.auditLog("draft_auto", {
          sid: safeSessionId(invocation.sessionId),
          id: persisted.id,
          promptHash: persisted.sourcePromptHash,
        });
        return { modifiedPrompt: appendActivationInstructions(prompt) };
      }

      if (activeGoal) {
        const sid = safeSessionId(invocation.sessionId);
        driftCountBySession.set(sid, 0);
        const turnGoal = await persistAndTrack(
          invocation,
          sessionCwd,
          appendGoalHistory(activeGoal, "turn", "User prompt submitted")
        );

        if (explicitlyReplaces && !isContinuePrompt) {
          return {
            modifiedPrompt: appendPromptNote(
              prompt,
              [
                "An active persisted goal already exists for this main session.",
                "Decide whether the prompt is replacing, correcting, or modifying it before overwriting. Use goal_system_status if the full snapshot is needed.",
                "If replacement is clearly intended, call goal_system_open with replaceExisting: true and preserve no invented facts.",
              ].join("\n")
            ),
          };
        }

        const drift = driftCountBySession.get(sid) || 0;
        let driftEnforcement = "";
        if (drift >= DRIFT_BLOCK_THRESHOLD) {
          driftEnforcement = `\nCRITICAL DRIFT: ${buildDriftEnforcement(drift, DRIFT_BLOCK_THRESHOLD)}`;
          store.auditLog("drift_critical", { sid, drift });
        } else if (drift >= DRIFT_WARN_THRESHOLD) {
          driftEnforcement = `\nDRIFT WARNING: ${drift} tool calls without a goal_system_update. Call goal_system_update with verified progress before continuing other work.`;
          store.auditLog("drift_warn", { sid, drift });
        }

        return { modifiedPrompt: appendPromptNote(prompt, buildGoalPromptNote(turnGoal) + driftEnforcement) };
      }

      if (isContinuePrompt) {
        const workspaceCandidates = await store.loadWorkspaceGoalCandidates(sessionCwd);
        const { record: workspaceGoal, openCount } = store.pickSingleOpenWorkspaceGoal(workspaceCandidates);
        if (workspaceGoal) {
          const hydrated = await hydrateSessionGoal(invocation, sessionCwd, workspaceGoal);
          return {
            modifiedPrompt: appendPromptNote(
              prompt,
              `${buildGoalPromptNote(hydrated)}\nA single unambiguous same-directory goal was loaded for continuation. Continue from persisted state, not memory.`
            ),
          };
        }
        if (openCount > 1) {
          return {
            modifiedPrompt: appendPromptNote(
              prompt,
              "Multiple active goals exist for this working directory across sessions. Do not guess which one to continue. Ask for the intended session or goal ID."
            ),
          };
        }
        return {
          modifiedPrompt: appendPromptNote(
            prompt,
            "No persisted active goal was found for this working directory. Do not pretend a goal exists. Reconstruct from supplied artifacts or ask for the missing objective."
          ),
        };
      }

      return;
    },

    onPreToolUse: async (input, invocation) => {
      const toolName = normalizeText(input.toolName, 120);
      const sessionId = safeSessionId(invocation.sessionId);
      if (isLikelySubagentInvocation(invocation)) return null;

      const sessionCwd = setSessionCwd(invocation.sessionId, input.cwd);
      const { activeGoal } = await loadCurrentOpenGoal(invocation, sessionCwd);
      if (!activeGoal || isGoalSystemToolName(toolName)) return null;

      const drift = driftCountBySession.get(sessionId) || 0;
      if (
        shouldEnforceDrift({
          hasActiveGoal: true,
          toolName,
          driftCount: drift,
          threshold: DRIFT_BLOCK_THRESHOLD,
          isSubagent: isLikelySubagentInvocation(invocation),
          hardBlockDrift: HARD_DRIFT_BLOCK,
          canRecoverWithGoalUpdate: true,
        })
      ) {
        const message = buildDriftEnforcement(drift, DRIFT_BLOCK_THRESHOLD);
        store.auditLog("drift_block", { sid: sessionId, drift, toolName });
        return {
          permissionDecision: "deny",
          permissionDecisionReason: message,
          additionalContext: message,
        };
      }

      if (drift >= DRIFT_BLOCK_THRESHOLD) {
        const message = buildDriftEnforcement(drift, DRIFT_BLOCK_THRESHOLD);
        store.auditLog("drift_critical_allow", { sid: sessionId, drift, toolName });
        return {
          permissionDecision: "allow",
          additionalContext: message,
        };
      }

      if (drift >= DRIFT_WARN_THRESHOLD) {
        return {
          additionalContext: `Goal-state drift warning: ${drift} tool calls have run since the last goal_system_update. Update the persisted goal at the next useful checkpoint.`,
        };
      }

      return null;
    },

    onPostToolUse: async (input, invocation) => {
      const toolName = normalizeText(input.toolName, 120);
      if (HISTORY_SKIP_TOOLS.has(toolName) || isGoalSystemToolName(toolName)) return;
      const sessionId = safeSessionId(invocation.sessionId);
      const sessionCwd = setSessionCwd(invocation.sessionId, input.cwd);
      if (!sessionId) return;
      if (isLikelySubagentInvocation(invocation)) return;

      if (!activeGoalSessions.has(sessionId)) {
        const loadedGoal = await store.loadGoalRecord(sessionId, sessionCwd);
        if (!loadedGoal || !isOpenGoal(loadedGoal.goal)) return;
        activateSessionIfOpen(sessionId, loadedGoal.goal);
      }

      driftCountBySession.set(sessionId, (driftCountBySession.get(sessionId) || 0) + 1);

      const note = summarizeToolUse(input);
      if (!note) return;
      if (!pendingHistoryBySession.has(sessionId)) pendingHistoryBySession.set(sessionId, []);
      const entries = pendingHistoryBySession.get(sessionId);
      if (entries.length < MAX_PENDING_ENTRIES) {
        entries.push({ at: new Date().toISOString(), type: "tool", note });
      }
      scheduleFlush();
    },

    onErrorOccurred: async (input, invocation) => {
      store.auditLog("sdk_error", {
        sid: safeSessionId(invocation.sessionId),
        error: input?.error?.message || input?.message || "unknown",
      });
      return;
    },

    onSessionEnd: async (_input, invocation) => {
      await ensureFlushed(invocation.sessionId);
      const sid = safeSessionId(invocation.sessionId);
      activeGoalSessions.delete(sid);
      pendingHistoryBySession.delete(sid);
      store.auditLog("session_end", { sid });
      return;
    },
  },

  tools: [
    {
      name: "goal_system_status",
      description: "Read the persisted active goal state for the current main session/workspace.",
      skipPermission: true,
      parameters: { type: "object", properties: {} },
      handler: async (_args, invocation) => {
        const subagentFailure = assertMainSessionTool(invocation);
        if (subagentFailure) return subagentFailure;
        await ensureFlushed(invocation.sessionId);
        const sessionCwd = getSessionCwd(invocation.sessionId, invocationCwd(invocation));
        const loadedGoal = await store.loadGoalRecord(invocation.sessionId, sessionCwd);
        if (!loadedGoal || !isOpenGoal(loadedGoal.goal)) return "No persisted active goal is stored for this main session/workspace.";
        activateSessionIfOpen(invocation.sessionId, loadedGoal.goal);
        return formatGoalSummary(loadedGoal.goal);
      },
    },

    {
      name: "goal_system_open",
      description: "Create or replace the persisted active goal for the current main session/workspace.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          ...goalToolProperties,
          completionStatus: { type: "string", enum: ["draft", "active", "blocked"] },
          replaceExisting: { type: "boolean" },
        },
        required: ["objective"],
      },
      handler: async (args, invocation) => {
        const subagentFailure = assertMainSessionTool(invocation);
        if (subagentFailure) return subagentFailure;
        await ensureFlushed(invocation.sessionId);
        const sessionCwd = getSessionCwd(invocation.sessionId, invocationCwd(invocation));
        const loadedGoal = await store.loadGoalRecord(invocation.sessionId, sessionCwd);
        if (loadedGoal && isOpenGoal(loadedGoal.goal) && args.replaceExisting !== true) {
          store.auditLog("open_blocked", { sid: safeSessionId(invocation.sessionId), reason: "existing_active" });
          return {
            textResultForLlm:
              "An active persisted goal already exists for this main session/workspace. Use goal_system_update to continue it, or call goal_system_open with replaceExisting: true only when the prompt clearly replaces the current goal.",
            resultType: "failure",
          };
        }
        const goal = createGoalRecord(args, invocation.sessionId, sessionCwd, {
          sourcePrompt: args.sourcePrompt,
          historyNote: args.historyNote || "Goal opened or replaced",
        });
        const persisted = await persistAndTrack(invocation, sessionCwd, goal);
        driftCountBySession.set(safeSessionId(invocation.sessionId), 0);
        store.auditLog("goal_open", {
          sid: safeSessionId(invocation.sessionId),
          id: persisted.id,
          promptHash: persisted.sourcePromptHash,
          replaced: Boolean(loadedGoal && isOpenGoal(loadedGoal.goal)),
        });
        return formatGoalSummary(persisted);
      },
    },

    {
      name: "goal_system_update",
      description: "Update the persisted active goal with verified facts, progress, blockers, issues, or proof.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          ...goalToolProperties,
          completionStatus: { type: "string", enum: MUTABLE_GOAL_STATUSES },
        },
      },
      handler: async (args, invocation) => {
        const subagentFailure = assertMainSessionTool(invocation);
        if (subagentFailure) return subagentFailure;
        await ensureFlushed(invocation.sessionId);
        const sessionCwd = getSessionCwd(invocation.sessionId, invocationCwd(invocation));
        const loadedGoal = await store.loadGoalRecord(invocation.sessionId, sessionCwd);
        if (!loadedGoal || !loadedGoal.goal) {
          return { textResultForLlm: "No persisted goal exists yet. Use goal_system_open first.", resultType: "failure" };
        }
        if (!isOpenGoal(loadedGoal.goal)) {
          return {
            textResultForLlm:
              "The persisted goal is already closed. Start a new goal with goal_system_open when the prompt explicitly asks for a replacement or new goal.",
            resultType: "failure",
          };
        }
        if (typeof args.completionStatus === "string" && !MUTABLE_GOAL_STATUSES.includes(args.completionStatus)) {
          store.auditLog("update_blocked", { sid: safeSessionId(invocation.sessionId), reason: "invalid_status", status: args.completionStatus });
          return {
            textResultForLlm: "goal_system_update cannot mark a goal complete or cancelled. Use goal_system_close after the goal is actually verified.",
            resultType: "failure",
          };
        }
        const changedFields = Object.keys(args).filter((k) => k !== "historyNote" && k !== "sourcePrompt" && args[k] !== undefined);
        if (!changedFields.length) {
          return {
            textResultForLlm:
              "goal_system_update requires at least one real state field such as inspectionEvidence, discoveredIssues, resolvedIssues, verificationResults, doneSoFar, remaining, blockers, or requirementCoverage. A history note alone is not enough.",
            resultType: "failure",
          };
        }
        const nextGoal = mergeGoal(loadedGoal.goal, args, "update", args.historyNote || "Goal state updated");
        const persisted = await persistAndTrack(invocation, sessionCwd, nextGoal);
        driftCountBySession.set(safeSessionId(invocation.sessionId), 0);
        store.auditLog("goal_update", { sid: safeSessionId(invocation.sessionId), id: persisted.id, fields: changedFields });
        return formatGoalSummary(persisted);
      },
    },

    {
      name: "goal_system_close",
      description: "Close the persisted goal as complete, blocked, or cancelled after real evidence is recorded.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          completionStatus: { type: "string", enum: ["complete", "blocked", "cancelled"] },
          summary: { type: "string" },
          ...goalToolProperties,
        },
        required: ["completionStatus"],
      },
      handler: async (args, invocation) => {
        const subagentFailure = assertMainSessionTool(invocation);
        if (subagentFailure) return subagentFailure;
        await ensureFlushed(invocation.sessionId);
        const sessionCwd = getSessionCwd(invocation.sessionId, invocationCwd(invocation));
        const loadedGoal = await store.loadGoalRecord(invocation.sessionId, sessionCwd);
        if (!loadedGoal || !loadedGoal.goal) {
          return { textResultForLlm: "No persisted goal exists yet, so there is nothing to close.", resultType: "failure" };
        }

        const patch = {
          ...args,
          completionStatus: GOAL_STATUSES.includes(args.completionStatus) ? args.completionStatus : loadedGoal.goal.completionStatus,
          blockers: args.completionStatus === "complete" && !Array.isArray(args.blockers) ? [] : args.blockers,
          remaining: args.completionStatus === "complete" && !Array.isArray(args.remaining) ? [] : args.remaining,
        };
        const nextGoal = mergeGoal(loadedGoal.goal, patch, "close", args.summary || `Goal marked ${args.completionStatus}`);
        nextGoal.closedAt = nowIso();

        if (args.completionStatus === "complete") {
          const failures = validateGoalCompletion(nextGoal);
          if (failures.length) {
            store.auditLog("close_refused", { sid: safeSessionId(invocation.sessionId), id: loadedGoal.goal.id, reasons: failures });
            return {
              textResultForLlm: `Refusing to mark the goal complete. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`,
              resultType: "failure",
            };
          }
        }

        const persisted = await persistAndTrack(invocation, sessionCwd, nextGoal);
        driftCountBySession.delete(safeSessionId(invocation.sessionId));
        store.auditLog("goal_close", { sid: safeSessionId(invocation.sessionId), id: persisted.id, status: args.completionStatus });
        return formatGoalSummary(persisted, { includeHistory: false });
      },
    },
  ],
});

await session.log("goal-system ready", { ephemeral: true });
store.auditLog("boot", { pid: process.pid });
