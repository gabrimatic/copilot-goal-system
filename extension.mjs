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
  normalizeUniqueList,
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

async function mutateAndTrack(invocation, cwd, mutator) {
  const persisted = await store.mutateGoalRecord(invocation.sessionId, cwd, mutator);
  if (persisted) activateSessionIfOpen(invocation.sessionId, persisted);
  return persisted;
}

function otherOpenGoalWarning(candidates, persistedGoal) {
  const others = candidates.filter((candidate) => isOpenGoal(candidate.goal) && candidate.goal.id !== persistedGoal.id);
  const sessionIds = [...new Set(others.map((candidate) => safeSessionId(candidate.goal.sessionId || "")))].filter(Boolean);
  if (!sessionIds.length) return "";
  return `\n\nWarning: other open goals exist in this workspace for session(s): ${sessionIds.join(", ")}. Use goal_system_status / pass sessionId explicitly to avoid cross-session confusion.`;
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
  await mutateAndTrack({ sessionId: sid }, sessionCwd, (goal) => {
    if (!isOpenGoal(goal)) return null;
    const history = Array.isArray(goal.history) ? goal.history.slice() : [];
    for (const entry of entries) history.push(entry);
    return { ...goal, history: history.slice(-40) };
  });
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
      "Do not answer with only 'goal-system loaded'. Inspect the user-requested target workspace, runtime, or artifact first, then call goal_system_checkpoint with verified facts before doing substantive work.",
      "Treat goal_system_* tools and local goalctl as the goal-state API. Do not read installed goal-system runtime files unless the user's task is to debug the goal system itself.",
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
            requirements: ["Inspect the user-requested target before treating any unverified task detail as fact."],
            doneSoFar: ["Draft goal record created from the explicit goal-mode prompt."],
            remaining: [
              "Inspect the user-requested target workspace, runtime, or artifact and replace draft fields with verified facts.",
              "Execute the goal, record discovered issues, fix them, verify with evidence, and finish only after audit.",
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
        const drift = driftCountBySession.get(sid) || 0;
        driftCountBySession.set(sid, 0);
        const turnGoal =
          (await mutateAndTrack(invocation, sessionCwd, (goal) => {
            if (!isOpenGoal(goal)) return null;
            return appendGoalHistory(goal, "turn", "User prompt submitted");
          })) || activeGoal;

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

        let driftEnforcement = "";
        if (drift >= DRIFT_BLOCK_THRESHOLD) {
          driftEnforcement = `\nCRITICAL DRIFT: ${buildDriftEnforcement(drift, DRIFT_BLOCK_THRESHOLD)}`;
          store.auditLog("drift_critical", { sid, drift });
        } else if (drift >= DRIFT_WARN_THRESHOLD) {
          driftEnforcement = `\nDRIFT WARNING: ${drift} tool calls without a goal_system_checkpoint. Call goal_system_checkpoint with verified progress before continuing other work.`;
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
          additionalContext: `Goal-state drift warning: ${drift} tool calls have run since the last goal_system_checkpoint. Save persisted progress at the next useful checkpoint.`,
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

    onPostToolUseFailure: async (input, invocation) => {
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

      const note = `tool-failed: ${summarizeToolUse(input) || toolName || "unknown"}`;
      if (!pendingHistoryBySession.has(sessionId)) pendingHistoryBySession.set(sessionId, []);
      const entries = pendingHistoryBySession.get(sessionId);
      if (entries.length < MAX_PENDING_ENTRIES) {
        entries.push({ at: new Date().toISOString(), type: "tool", note });
      }
      scheduleFlush();
      store.auditLog("tool_failure", { sid: sessionId, toolName });
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

        let refusal = null;
        let replaced = false;
        const persisted = await mutateAndTrack(invocation, sessionCwd, (existingGoal) => {
          if (isOpenGoal(existingGoal) && args.replaceExisting !== true) {
            store.auditLog("open_blocked", { sid: safeSessionId(invocation.sessionId), reason: "existing_active" });
            refusal = {
              textResultForLlm:
                "An active persisted goal already exists for this main session/workspace. Use goal_system_checkpoint to continue it, or call goal_system_open with replaceExisting: true only when the prompt clearly replaces the current goal.",
              resultType: "failure",
            };
            return null;
          }
          replaced = isOpenGoal(existingGoal);
          return createGoalRecord(args, invocation.sessionId, sessionCwd, {
            sourcePrompt: args.sourcePrompt,
            historyNote: args.historyNote || "Goal opened or replaced",
          });
        });

        if (refusal) return refusal;

        driftCountBySession.set(safeSessionId(invocation.sessionId), 0);
        store.auditLog("goal_open", {
          sid: safeSessionId(invocation.sessionId),
          id: persisted.id,
          promptHash: persisted.sourcePromptHash,
          replaced,
        });
        const warning = otherOpenGoalWarning(await store.loadWorkspaceGoalCandidates(sessionCwd), persisted);
        return `${formatGoalSummary(persisted)}${warning}`;
      },
    },

    {
      name: "goal_system_checkpoint",
      description: "Agent-friendly progress checkpoint. Save verified progress, evidence, blockers, verification, and remaining work.",
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
        if (typeof args.completionStatus === "string" && !MUTABLE_GOAL_STATUSES.includes(args.completionStatus)) {
          store.auditLog("checkpoint_blocked", { sid: safeSessionId(invocation.sessionId), reason: "invalid_status", status: args.completionStatus });
          return {
            textResultForLlm: "goal_system_checkpoint cannot mark a goal complete or cancelled. Use goal_system_finish after the goal is actually verified.",
            resultType: "failure",
          };
        }
        const changedFields = Object.keys(args).filter((k) => k !== "historyNote" && k !== "sourcePrompt" && args[k] !== undefined);
        if (!changedFields.length) {
          return {
            textResultForLlm:
              "goal_system_checkpoint requires at least one real state field such as inspectionEvidence, discoveredIssues, resolvedIssues, verificationResults, doneSoFar, remaining, blockers, or requirementCoverage.",
            resultType: "failure",
          };
        }

        let refusal = null;
        const persisted = await mutateAndTrack(invocation, sessionCwd, (goal) => {
          if (!goal) {
            refusal = { textResultForLlm: "No persisted goal exists yet. Use goal_system_open first.", resultType: "failure" };
            return null;
          }
          if (!isOpenGoal(goal)) {
            refusal = {
              textResultForLlm:
                "The persisted goal is already closed. Start a new goal with goal_system_open when the prompt explicitly asks for a replacement or new goal.",
              resultType: "failure",
            };
            return null;
          }
          const checkpointPatch = { ...args };
          if (goal.completionStatus === "draft" && checkpointPatch.completionStatus === undefined) {
            checkpointPatch.completionStatus = "active";
          }
          return mergeGoal(goal, checkpointPatch, "update", checkpointPatch.historyNote || "Checkpoint saved");
        });

        if (refusal) return refusal;

        driftCountBySession.set(safeSessionId(invocation.sessionId), 0);
        store.auditLog("goal_checkpoint", { sid: safeSessionId(invocation.sessionId), id: persisted.id, fields: changedFields });
        return `Checkpoint saved.\n${formatGoalSummary(persisted)}`;
      },
    },

    {
      name: "goal_system_update",
      description: "Compatibility tool for structured goal-state edits. Prefer goal_system_checkpoint for normal progress.",
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
        if (typeof args.completionStatus === "string" && !MUTABLE_GOAL_STATUSES.includes(args.completionStatus)) {
          store.auditLog("update_blocked", { sid: safeSessionId(invocation.sessionId), reason: "invalid_status", status: args.completionStatus });
          return {
            textResultForLlm: "goal_system_update cannot mark a goal complete or cancelled. Use goal_system_finish after the goal is actually verified.",
            resultType: "failure",
          };
        }
        const changedFields = Object.keys(args).filter((k) => k !== "historyNote" && k !== "sourcePrompt" && args[k] !== undefined);
        if (!changedFields.length) {
          return {
            textResultForLlm:
              "goal_system_update requires at least one real state field such as inspectionEvidence, discoveredIssues, resolvedIssues, verificationResults, doneSoFar, remaining, blockers, or requirementCoverage. A history note alone is not enough. For normal progress, use goal_system_checkpoint.",
            resultType: "failure",
          };
        }

        let refusal = null;
        const persisted = await mutateAndTrack(invocation, sessionCwd, (goal) => {
          if (!goal) {
            refusal = { textResultForLlm: "No persisted goal exists yet. Use goal_system_open first.", resultType: "failure" };
            return null;
          }
          if (!isOpenGoal(goal)) {
            refusal = {
              textResultForLlm:
                "The persisted goal is already closed. Start a new goal with goal_system_open when the prompt explicitly asks for a replacement or new goal.",
              resultType: "failure",
            };
            return null;
          }
          return mergeGoal(goal, args, "update", args.historyNote || "Goal state updated");
        });

        if (refusal) return refusal;

        driftCountBySession.set(safeSessionId(invocation.sessionId), 0);
        store.auditLog("goal_update", { sid: safeSessionId(invocation.sessionId), id: persisted.id, fields: changedFields });
        return formatGoalSummary(persisted);
      },
    },

    {
      name: "goal_system_finish",
      description: "Agent-friendly completion action. Close the current goal as complete after proof fields are recorded.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          ...goalToolProperties,
        },
      },
      handler: async (args, invocation) => {
        const subagentFailure = assertMainSessionTool(invocation);
        if (subagentFailure) return subagentFailure;
        await ensureFlushed(invocation.sessionId);
        const sessionCwd = getSessionCwd(invocation.sessionId, invocationCwd(invocation));

        let refusal = null;
        const persisted = await mutateAndTrack(invocation, sessionCwd, (goal) => {
          if (!goal) {
            refusal = { textResultForLlm: "No persisted goal exists yet, so there is nothing to finish.", resultType: "failure" };
            return null;
          }
          if (!isOpenGoal(goal)) {
            refusal = {
              textResultForLlm:
                "The persisted goal is already closed. Start a new goal with goal_system_open when the prompt explicitly asks for a replacement or new goal.",
              resultType: "failure",
            };
            return null;
          }

          const remainingProvided = Array.isArray(args.remaining);
          const priorRemaining = normalizeUniqueList(goal.remaining);
          if (!remainingProvided && priorRemaining.length) {
            store.auditLog("finish_refused", { sid: safeSessionId(invocation.sessionId), id: goal.id, reason: "remaining_recorded" });
            refusal = {
              textResultForLlm: `Refusing to finish the goal. Remaining work is still recorded: ${priorRemaining.join(" | ")}. Resolve it, then call goal_system_finish again with remaining: [] explicitly, or move it into blockers/issueResolutions first.`,
              resultType: "failure",
            };
            return null;
          }

          const patch = {
            ...args,
            completionStatus: "complete",
            blockers: Array.isArray(args.blockers) ? args.blockers : [],
            remaining: remainingProvided ? args.remaining : [],
          };
          const nextGoal = mergeGoal(goal, patch, "close", args.summary || "Goal finished");
          nextGoal.closedAt = nowIso();

          const failures = validateGoalCompletion(nextGoal);
          if (failures.length) {
            store.auditLog("finish_refused", { sid: safeSessionId(invocation.sessionId), id: goal.id, reasons: failures });
            refusal = {
              textResultForLlm: `Refusing to finish the goal. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`,
              resultType: "failure",
            };
            return null;
          }

          return nextGoal;
        });

        if (refusal) return refusal;

        driftCountBySession.delete(safeSessionId(invocation.sessionId));
        store.auditLog("goal_finish", { sid: safeSessionId(invocation.sessionId), id: persisted.id });
        return `Goal finished.\n${formatGoalSummary(persisted, { includeHistory: false })}`;
      },
    },

    {
      name: "goal_system_close",
      description: "Compatibility tool to close complete, blocked, or cancelled goals. Prefer goal_system_finish for normal completion.",
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

        let refusal = null;
        const persisted = await mutateAndTrack(invocation, sessionCwd, (goal) => {
          if (!goal) {
            refusal = { textResultForLlm: "No persisted goal exists yet, so there is nothing to close.", resultType: "failure" };
            return null;
          }

          const patch = {
            ...args,
            completionStatus: GOAL_STATUSES.includes(args.completionStatus) ? args.completionStatus : goal.completionStatus,
            blockers: args.completionStatus === "complete" && !Array.isArray(args.blockers) ? [] : args.blockers,
            remaining: args.completionStatus === "complete" && !Array.isArray(args.remaining) ? [] : args.remaining,
          };
          const nextGoal = mergeGoal(goal, patch, "close", args.summary || `Goal marked ${args.completionStatus}`);
          nextGoal.closedAt = nowIso();

          if (args.completionStatus === "complete") {
            const failures = validateGoalCompletion(nextGoal);
            if (failures.length) {
              store.auditLog("close_refused", { sid: safeSessionId(invocation.sessionId), id: goal.id, reasons: failures });
              refusal = {
                textResultForLlm: `Refusing to mark the goal complete. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`,
                resultType: "failure",
              };
              return null;
            }
          }

          return nextGoal;
        });

        if (refusal) return refusal;

        driftCountBySession.delete(safeSessionId(invocation.sessionId));
        store.auditLog("goal_close", { sid: safeSessionId(invocation.sessionId), id: persisted.id, status: args.completionStatus });
        return formatGoalSummary(persisted, { includeHistory: false });
      },
    },
  ],
});

await session.log("goal-system ready", { ephemeral: true });
store.auditLog("boot", { pid: process.pid });
