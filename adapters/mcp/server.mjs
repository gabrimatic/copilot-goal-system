#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  GOAL_STATUSES,
  MUTABLE_GOAL_STATUSES,
  GoalStore,
  createGoalRecord,
  formatGoalSummary,
  isOpenGoal,
  mergeGoal,
  normalizeCwd,
  normalizeUniqueList,
  safeSessionId,
  validateGoalCompletion,
} from "../../lib/goal-core.mjs";

const SERVER_NAME = "copilot-goal-system";
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const SERVER_VERSION = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
const ALLOW_PATH_OVERRIDES = process.env.GOAL_SYSTEM_ALLOW_PATH_OVERRIDES === "1";

const baseFields = {
  sessionId: z.string().optional().describe("Goal session ID from the client or hook context."),
  cwd: z.string().optional().describe("Workspace directory for the persisted goal."),
  home: z.string().optional().describe("Optional OS home directory override for tests or non-default profiles."),
  stateRoot: z.string().optional().describe("Optional explicit goal-system state root."),
  workspaceStateRoot: z.string().optional().describe("Optional explicit workspace state root."),
};

const listFieldSchemas = {
  requirements: z.array(z.string()).optional(),
  scope: z.array(z.string()).optional(),
  mustNotRegress: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  currentEnvironment: z.array(z.string()).optional(),
  requiredTools: z.array(z.string()).optional(),
  validationProof: z.array(z.string()).optional(),
  verificationResults: z.array(z.string()).optional(),
  requirementCoverage: z.array(z.string()).optional(),
  inspectionEvidence: z.array(z.string()).optional(),
  discoveredIssues: z.array(z.string()).optional(),
  resolvedIssues: z.array(z.string()).optional(),
  doneSoFar: z.array(z.string()).optional(),
  remaining: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  completionAudit: z.array(z.string()).optional(),
};

const issueResolutionSchema = z.object({
  covers: z.array(z.string()).optional(),
  issue: z.string().optional(),
  originalIssue: z.string().optional(),
  target: z.string().optional(),
  targetIssue: z.string().optional(),
  status: z.enum(["resolved", "merged", "renamed", "duplicate", "superseded"]).optional(),
  resolution: z.string().optional(),
  evidence: z.array(z.string()).optional(),
});

const goalPatchFields = {
  objective: z.string().optional(),
  ...listFieldSchemas,
  issueResolutions: z.array(issueResolutionSchema).optional(),
  sourcePrompt: z.string().optional(),
  historyNote: z.string().optional(),
};

const statusSchema = z.object(baseFields);
const openSchema = z.object({
  ...baseFields,
  ...goalPatchFields,
  objective: z.string(),
  completionStatus: z.enum(["draft", "active", "blocked"]).optional(),
  replaceExisting: z.boolean().optional(),
});
const checkpointSchema = z.object({
  ...baseFields,
  ...goalPatchFields,
  completionStatus: z.enum(MUTABLE_GOAL_STATUSES).optional(),
});
const closeSchema = z.object({
  ...baseFields,
  ...goalPatchFields,
  completionStatus: z.enum(["complete", "blocked", "cancelled"]),
  summary: z.string().optional(),
});
const finishSchema = z.object({
  ...baseFields,
  ...goalPatchFields,
});

function copilotRootForInput(input = {}) {
  if (process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  const home = input.home ? path.resolve(String(input.home)) : os.homedir();
  return path.join(home, ".copilot");
}

function assertPathOverridesAllowed(input = {}) {
  const overridden = ["home", "stateRoot", "workspaceStateRoot"].filter((key) => input[key] !== undefined);
  if (overridden.length && !ALLOW_PATH_OVERRIDES) {
    throw new Error(
      `Path overrides (${overridden.join(", ")}) are disabled for this MCP server. Set GOAL_SYSTEM_ALLOW_PATH_OVERRIDES=1 in the server environment to allow them.`
    );
  }
}

async function createStore(input = {}) {
  assertPathOverridesAllowed(input);
  const copilotRoot = copilotRootForInput(input);
  const store = new GoalStore({
    stateRoot: input.stateRoot || process.env.GOAL_SYSTEM_STATE_ROOT || path.join(copilotRoot, "session-state", "goal-system"),
    workspaceStateRoot: input.workspaceStateRoot || path.join(copilotRoot, "session-state"),
  });
  await store.init();
  return store;
}

function explicitSessionId(input = {}) {
  const raw = input.sessionId || process.env.GOAL_SYSTEM_SESSION_ID || "";
  if (!raw) return "";
  const sessionId = safeSessionId(raw);
  return sessionId && sessionId !== "unknown-session" ? sessionId : "";
}

function inputCwd(input = {}) {
  return normalizeCwd(input.cwd || process.env.GOAL_SYSTEM_CWD || process.cwd());
}

function openWorkspaceGoalSessions(records) {
  const bySession = new Map();
  for (const record of records.filter((candidate) => isOpenGoal(candidate.goal))) {
    const sessionId = safeSessionId(record.goal.sessionId || "");
    if (!sessionId || sessionId === "unknown-session") continue;
    bySession.set(sessionId, record.goal.objective || "unknown until inspected");
  }
  return [...bySession.entries()].map(([sessionId, objective]) => `${sessionId} (${objective})`);
}

async function contextFromInput(store, input = {}, options = {}) {
  const { allowMissingSession = false } = options;
  const cwd = inputCwd(input);
  const explicit = explicitSessionId(input);
  if (explicit) return { sessionId: explicit, cwd, inferred: false, record: null };

  const candidates = await store.loadWorkspaceGoalCandidates(cwd);
  const { record, openCount } = store.pickSingleOpenWorkspaceGoal(candidates);
  if (record?.goal) {
    return { sessionId: safeSessionId(record.goal.sessionId), cwd, inferred: true, record };
  }

  if (openCount > 1) {
    const sessions = openWorkspaceGoalSessions(candidates);
    throw new Error(
      `Multiple active goals exist for this working directory. Pass sessionId explicitly. Open sessions: ${sessions.join("; ")}`
    );
  }

  if (allowMissingSession) return { sessionId: "", cwd, inferred: false, record: null };
  throw new Error(
    "A sessionId is required unless exactly one active goal exists for the current working directory."
  );
}

function patchFromInput(input = {}) {
  const patch = { ...input };
  for (const key of ["sessionId", "cwd", "home", "stateRoot", "workspaceStateRoot", "replaceExisting"]) {
    delete patch[key];
  }
  return patch;
}

function otherOpenGoalWarning(candidates, persistedGoal) {
  const others = candidates.filter((candidate) => isOpenGoal(candidate.goal) && candidate.goal.id !== persistedGoal.id);
  const sessionIds = [...new Set(others.map((candidate) => safeSessionId(candidate.goal.sessionId || "")))].filter(Boolean);
  if (!sessionIds.length) return "";
  return `\n\nWarning: other open goals exist in this workspace for session(s): ${sessionIds.join(", ")}. Use goal_system_status / pass sessionId explicitly to avoid cross-session confusion.`;
}

function toolResult(text, goal = null, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      ok: true,
      goal,
      ...extra,
    },
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error?.message || String(error) }],
    structuredContent: {
      ok: false,
      error: error?.message || String(error),
    },
  };
}

async function handleStatus(input) {
  const store = await createStore(input);
  const { sessionId, cwd, record: inferredRecord } = await contextFromInput(store, input, { allowMissingSession: true });
  const record = inferredRecord || (sessionId ? await store.loadGoalRecord(sessionId, cwd) : null);
  if (!record || !isOpenGoal(record.goal)) {
    return toolResult("No persisted active goal is stored for this workspace.", null);
  }
  return toolResult(formatGoalSummary(record.goal, { includeHistory: true }), record.goal);
}

async function handleOpen(input) {
  const store = await createStore(input);
  const sessionId = explicitSessionId(input);
  if (!sessionId) throw new Error("open requires sessionId from the client or hook context.");
  const cwd = inputCwd(input);
  const patch = patchFromInput(input);

  let replaced = false;
  const persisted = await store.mutateGoalRecord(sessionId, cwd, (existingGoal) => {
    if (isOpenGoal(existingGoal) && input.replaceExisting !== true) {
      throw new Error(
        "An active persisted goal already exists for this session/workspace. Use checkpoint/update, or set replaceExisting only when the prompt clearly replaces the current goal."
      );
    }
    replaced = isOpenGoal(existingGoal);
    return createGoalRecord(patch, sessionId, cwd, {
      sourcePrompt: patch.sourcePrompt,
      historyNote: patch.historyNote || "Goal opened or replaced from MCP",
    });
  });

  store.auditLog("mcp_open", { sid: sessionId, id: persisted.id, replaced });
  const warning = otherOpenGoalWarning(await store.loadWorkspaceGoalCandidates(cwd), persisted);
  return toolResult(`${formatGoalSummary(persisted)}${warning}`, persisted, { action: "open" });
}

async function handleUpdate(input, label = "update") {
  const store = await createStore(input);
  const { sessionId, cwd } = await contextFromInput(store, input);
  if (typeof input.completionStatus === "string" && !MUTABLE_GOAL_STATUSES.includes(input.completionStatus)) {
    throw new Error("checkpoint/update cannot mark a goal complete or cancelled. Use finish/close after verification.");
  }

  const patch = patchFromInput(input);
  const changedFields = Object.keys(patch).filter((key) => !["historyNote", "sourcePrompt"].includes(key) && patch[key] !== undefined);
  if (!changedFields.length) {
    throw new Error("checkpoint/update requires at least one real state field such as doneSoFar, remaining, blockers, inspectionEvidence, or verificationResults.");
  }

  const persisted = await store.mutateGoalRecord(sessionId, cwd, (goal) => {
    if (!goal) throw new Error("No persisted goal exists yet. Use open first.");
    if (!isOpenGoal(goal)) throw new Error("The persisted goal is already closed. Open a new goal only for an explicit replacement.");

    const checkpointPatch = { ...patch };
    if (label === "checkpoint" && goal.completionStatus === "draft" && checkpointPatch.completionStatus === undefined) {
      checkpointPatch.completionStatus = "active";
    }

    return mergeGoal(
      goal,
      checkpointPatch,
      "update",
      checkpointPatch.historyNote || (label === "checkpoint" ? "Checkpoint saved from MCP" : "Goal state updated from MCP")
    );
  });

  store.auditLog("mcp_update", { sid: sessionId, id: persisted.id, fields: changedFields });
  const prefix = label === "checkpoint" ? "Checkpoint saved.\n" : "";
  return toolResult(`${prefix}${formatGoalSummary(persisted)}`, persisted, { action: label });
}

async function handleClose(input, label = "close") {
  const store = await createStore(input);
  const { sessionId, cwd } = await contextFromInput(store, input);
  const patch = patchFromInput(input);
  if (!GOAL_STATUSES.includes(patch.completionStatus) || patch.completionStatus === "draft" || patch.completionStatus === "active") {
    throw new Error("close requires completionStatus complete, blocked, or cancelled. Agent-friendly aliases are finish, block, and cancel.");
  }

  const persisted = await store.mutateGoalRecord(sessionId, cwd, (goal) => {
    if (!goal) throw new Error("No persisted goal exists yet, so there is nothing to close.");

    if (label === "finish") {
      const remainingProvided = Array.isArray(input.remaining);
      const priorRemaining = normalizeUniqueList(goal.remaining);
      if (!remainingProvided && priorRemaining.length) {
        throw new Error(
          `Refusing to finish the goal. Remaining work is still recorded: ${priorRemaining.join(" | ")}. Resolve it, then call goal_system_finish again with remaining: [] explicitly, or move it into blockers/issueResolutions first.`
        );
      }
    }

    const nextGoal = mergeGoal(
      goal,
      {
        ...patch,
        blockers: patch.completionStatus === "complete" && !Array.isArray(patch.blockers) ? [] : patch.blockers,
        remaining: patch.completionStatus === "complete" && !Array.isArray(patch.remaining) ? [] : patch.remaining,
      },
      "close",
      patch.summary || `Goal marked ${patch.completionStatus} from MCP`
    );
    nextGoal.closedAt = new Date().toISOString();

    if (patch.completionStatus === "complete") {
      const failures = validateGoalCompletion(nextGoal);
      if (failures.length) {
        throw new Error(`Refusing to mark the goal complete. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`);
      }
    }

    return nextGoal;
  });

  store.auditLog("mcp_close", { sid: sessionId, id: persisted.id, status: patch.completionStatus });
  const prefix =
    label === "finish" ? "Goal finished.\n" :
      label === "block" ? "Goal blocked.\n" :
        label === "cancel" ? "Goal cancelled.\n" :
          "";
  return toolResult(`${prefix}${formatGoalSummary(persisted, { includeHistory: false })}`, persisted, { action: label });
}

function guarded(handler) {
  return async (input) => {
    try {
      return await handler(input || {});
    } catch (error) {
      return toolError(error);
    }
  };
}

function registerGoalTools(server) {
  server.registerTool(
    "goal_system_status",
    {
      title: "Goal System Status",
      description: "Read the persisted active goal state for this session or the single active goal in the current workspace.",
      inputSchema: statusSchema,
    },
    guarded(handleStatus)
  );
  server.registerTool(
    "goal_system_open",
    {
      title: "Goal System Open",
      description: "Create or replace a persisted goal for the main session.",
      inputSchema: openSchema,
    },
    guarded(handleOpen)
  );
  server.registerTool(
    "goal_system_checkpoint",
    {
      title: "Goal System Checkpoint",
      description: "Save verified progress, evidence, remaining work, blockers, or test results without closing the goal.",
      inputSchema: checkpointSchema,
    },
    guarded((input) => handleUpdate(input, "checkpoint"))
  );
  server.registerTool(
    "goal_system_update",
    {
      title: "Goal System Update",
      description: "Compatibility tool for structured edits to the persisted active goal.",
      inputSchema: checkpointSchema,
    },
    guarded(handleUpdate)
  );
  server.registerTool(
    "goal_system_finish",
    {
      title: "Goal System Finish",
      description: "Mark a goal complete only after inspection evidence, validation proof, verification results, requirement coverage, and completion audit are present.",
      inputSchema: finishSchema,
    },
    guarded((input) => handleClose({ ...input, completionStatus: "complete" }, "finish"))
  );
  server.registerTool(
    "goal_system_block",
    {
      title: "Goal System Block",
      description: "Mark a goal blocked with a real blocker and any evidence gathered so far.",
      inputSchema: finishSchema,
    },
    guarded((input) => handleClose({ ...input, completionStatus: "blocked" }, "block"))
  );
  server.registerTool(
    "goal_system_cancel",
    {
      title: "Goal System Cancel",
      description: "Cancel a goal only when the user explicitly cancels or replaces it.",
      inputSchema: finishSchema,
    },
    guarded((input) => handleClose({ ...input, completionStatus: "cancelled" }, "cancel"))
  );
  server.registerTool(
    "goal_system_close",
    {
      title: "Goal System Close",
      description: "Compatibility tool to close complete, blocked, or cancelled goals.",
      inputSchema: closeSchema,
    },
    guarded(handleClose)
  );
}

async function main() {
  if (process.argv.includes("--self-test")) {
    process.stdout.write("copilot-goal-system MCP server ready\n");
    return;
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerGoalTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
