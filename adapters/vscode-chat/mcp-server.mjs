#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  GOAL_STATUSES,
  ISSUE_RESOLUTION_STATUSES,
  MUTABLE_GOAL_STATUSES,
  GoalStore,
  createGoalRecord,
  formatGoalSummary,
  isOpenGoal,
  mergeGoal,
  normalizeCwd,
  safeSessionId,
  validateGoalCompletion,
} from "../../lib/goal-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const store = new GoalStore();
await store.init();

const textArray = z.array(z.string()).optional();
const issueResolutionSchema = z
  .object({
    covers: z.array(z.string()).optional(),
    issue: z.string().optional(),
    originalIssue: z.string().optional(),
    target: z.string().optional(),
    targetIssue: z.string().optional(),
    status: z.enum(ISSUE_RESOLUTION_STATUSES).optional(),
    resolution: z.string().optional(),
    evidence: z.array(z.string()).optional(),
  })
  .describe("Evidence-backed resolution coverage for discovered issues without requiring literal resolvedIssues strings.");
const goalPatchShape = {
  objective: z.string().optional(),
  requirements: textArray,
  scope: textArray,
  mustNotRegress: textArray,
  constraints: textArray,
  currentEnvironment: textArray,
  requiredTools: textArray,
  validationProof: textArray,
  verificationResults: textArray,
  requirementCoverage: textArray,
  inspectionEvidence: textArray,
  discoveredIssues: textArray,
  resolvedIssues: textArray,
  issueResolutions: z.array(issueResolutionSchema).optional(),
  doneSoFar: textArray,
  remaining: textArray,
  blockers: textArray,
  completionAudit: textArray,
  sourcePrompt: z.string().optional(),
  historyNote: z.string().optional(),
};

const contextShape = {
  sessionId: z.string().min(1).describe("The VS Code Chat sessionId from the goal hook context."),
  cwd: z.string().min(1).describe("The workspace cwd from the goal hook context."),
};

function toolResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function context(args) {
  return {
    sessionId: safeSessionId(args.sessionId),
    cwd: normalizeCwd(args.cwd),
  };
}

async function loadGoal(args) {
  const ctx = context(args);
  const record = await store.loadGoalRecord(ctx.sessionId, ctx.cwd);
  return { ...ctx, record };
}

async function statusHandler(args) {
  const { record } = await loadGoal(args);
  if (!record || !isOpenGoal(record.goal)) {
    return toolResult("No persisted active goal is stored for this VS Code Chat session/workspace.");
  }
  return toolResult(formatGoalSummary(record.goal, { includeHistory: true }));
}

async function openHandler(args) {
  const { sessionId, cwd, record } = await loadGoal(args);
  if (record && isOpenGoal(record.goal) && args.replaceExisting !== true) {
    return toolResult(
      "An active persisted goal already exists for this VS Code Chat session/workspace. Use goal_system_update to continue it, or call goal_system_open with replaceExisting: true only when the user clearly intends to replace the current goal.",
      true
    );
  }

  const goal = createGoalRecord(args, sessionId, cwd, {
    sourcePrompt: args.sourcePrompt,
    historyNote: args.historyNote || "VS Code Chat goal opened or replaced",
  });
  const persisted = await store.persistGoalRecord(sessionId, cwd, goal);
  store.auditLog("vscode_goal_open", {
    sid: sessionId,
    id: persisted.id,
    replaced: Boolean(record && isOpenGoal(record.goal)),
  });
  return toolResult(formatGoalSummary(persisted));
}

async function updateHandler(args) {
  const { sessionId, cwd, record } = await loadGoal(args);
  if (!record || !record.goal) {
    return toolResult("No persisted goal exists yet. Use goal_system_open first with the current sessionId and cwd.", true);
  }
  if (!isOpenGoal(record.goal)) {
    return toolResult("The persisted goal is already closed. Open a new goal only when the user explicitly asks for one.", true);
  }
  if (typeof args.completionStatus === "string" && !MUTABLE_GOAL_STATUSES.includes(args.completionStatus)) {
    return toolResult("goal_system_update cannot mark a goal complete or cancelled. Use goal_system_close after verification.", true);
  }

  const changedFields = Object.keys(args).filter((key) => !["sessionId", "cwd", "historyNote", "sourcePrompt"].includes(key) && args[key] !== undefined);
  if (!changedFields.length) {
    return toolResult(
      "goal_system_update requires at least one real state field such as inspectionEvidence, discoveredIssues, resolvedIssues, verificationResults, doneSoFar, remaining, blockers, or requirementCoverage.",
      true
    );
  }

  const nextGoal = mergeGoal(record.goal, args, "update", args.historyNote || "VS Code Chat goal state updated");
  const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
  store.auditLog("vscode_goal_update", { sid: sessionId, id: persisted.id, fields: changedFields });
  return toolResult(formatGoalSummary(persisted));
}

async function closeHandler(args) {
  const { sessionId, cwd, record } = await loadGoal(args);
  if (!record || !record.goal) {
    return toolResult("No persisted goal exists yet, so there is nothing to close.", true);
  }

  const patch = {
    ...args,
    completionStatus: GOAL_STATUSES.includes(args.completionStatus) ? args.completionStatus : record.goal.completionStatus,
    blockers: args.completionStatus === "complete" && !Array.isArray(args.blockers) ? [] : args.blockers,
    remaining: args.completionStatus === "complete" && !Array.isArray(args.remaining) ? [] : args.remaining,
  };
  const nextGoal = mergeGoal(record.goal, patch, "close", args.summary || `VS Code Chat goal marked ${args.completionStatus}`);
  nextGoal.closedAt = new Date().toISOString();

  if (args.completionStatus === "complete") {
    const failures = validateGoalCompletion(nextGoal);
    if (failures.length) {
      store.auditLog("vscode_close_refused", { sid: sessionId, id: record.goal.id, reasons: failures });
      return toolResult(`Refusing to mark the goal complete. Missing or conflicting completion evidence:\n- ${failures.join("\n- ")}`, true);
    }
  }

  const persisted = await store.persistGoalRecord(sessionId, cwd, nextGoal);
  store.auditLog("vscode_goal_close", { sid: sessionId, id: persisted.id, status: args.completionStatus });
  return toolResult(formatGoalSummary(persisted, { includeHistory: false }));
}

const server = new McpServer({
  name: "copilot-goal-system",
  version: packageJson.version || "0.0.0",
});

server.tool(
  "goal_system_status",
  "Read the persisted active goal state for the current VS Code Chat session/workspace. Requires the sessionId and cwd injected by the goal hook.",
  contextShape,
  statusHandler
);

server.tool(
  "goal_system_open",
  "Create or replace the persisted active goal for the current VS Code Chat session/workspace.",
  {
    ...contextShape,
    ...goalPatchShape,
    objective: z.string(),
    completionStatus: z.enum(["draft", "active", "blocked"]).optional(),
    replaceExisting: z.boolean().optional(),
  },
  openHandler
);

server.tool(
  "goal_system_update",
  "Update the persisted active goal with verified facts, progress, blockers, issues, or proof.",
  {
    ...contextShape,
    ...goalPatchShape,
    completionStatus: z.enum(MUTABLE_GOAL_STATUSES).optional(),
  },
  updateHandler
);

server.tool(
  "goal_system_close",
  "Close the persisted goal as complete, blocked, or cancelled after real evidence is recorded.",
  {
    ...contextShape,
    ...goalPatchShape,
    completionStatus: z.enum(["complete", "blocked", "cancelled"]),
    summary: z.string().optional(),
  },
  closeHandler
);

if (process.argv.includes("--self-test")) {
  process.stdout.write("copilot-goal-system MCP server ready\n");
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
