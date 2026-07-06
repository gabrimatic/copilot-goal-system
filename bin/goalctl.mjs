#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

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
} from "../lib/goal-core.mjs";

const listFlagMap = new Map([
  ["--requirement", "requirements"],
  ["--scope", "scope"],
  ["--must-not-regress", "mustNotRegress"],
  ["--constraint", "constraints"],
  ["--environment", "currentEnvironment"],
  ["--tool", "requiredTools"],
  ["--validation", "validationProof"],
  ["--verification", "verificationResults"],
  ["--verify", "verificationResults"],
  ["--coverage", "requirementCoverage"],
  ["--inspection", "inspectionEvidence"],
  ["--inspect", "inspectionEvidence"],
  ["--evidence", "inspectionEvidence"],
  ["--issue", "discoveredIssues"],
  ["--resolved", "resolvedIssues"],
  ["--fixed", "resolvedIssues"],
  ["--done", "doneSoFar"],
  ["--remaining", "remaining"],
  ["--next", "remaining"],
  ["--blocker", "blockers"],
  ["--audit", "completionAudit"],
  ["--proof", "validationProof"],
]);

const scalarFlagMap = new Map([
  ["--session-id", "sessionId"],
  ["--sessionId", "sessionId"],
  ["--cwd", "cwd"],
  ["--objective", "objective"],
  ["--status", "completionStatus"],
  ["--summary", "summary"],
  ["--note", "historyNote"],
  ["--history-note", "historyNote"],
  ["--source-prompt", "sourcePrompt"],
  ["--home", "home"],
  ["--state-root", "stateRoot"],
  ["--workspace-state-root", "workspaceStateRoot"],
  ["--input-json", "inputJson"],
]);

function usage() {
  return `Usage:
  goalctl status [--session-id <id>] [--cwd <path>] [--json]
  goalctl checkpoint [--session-id <id>] [--cwd <path>] (--done <text> | --evidence <text> | --verify <text> | --next <text> | field flags...)
  goalctl finish [--session-id <id>] [--cwd <path>] --done <text> --evidence <text> --proof <text> --verify <text> --audit <text> [--clear-remaining]
  goalctl block [--session-id <id>] [--cwd <path>] --blocker <text> [--done <text>] [--evidence <text>]
  goalctl cancel [--session-id <id>] [--cwd <path>] [--summary <text>]

Flags:
  --clear-remaining  For finish: explicitly clear recorded remaining work. Required when remaining
                      items are still recorded and were not resolved into --remaining/--next this call.

Compatibility commands:
  goalctl update [--session-id <id>] [--cwd <path>] (--input-json <json> | --stdin | field flags...)
  goalctl close [--session-id <id>] [--cwd <path>] --status complete|blocked|cancelled [--input-json <json>]
  goalctl open --session-id <id> --cwd <path> --objective <text> [--replace-existing]

Examples:
  goalctl status
  goalctl checkpoint --done "Inspected files" --next "Run tests"
  goalctl finish --done "Implemented fix" --evidence "Inspected target files" --proof "Completion gate checked" --verify "npm test passed" --audit "No remaining work"
  GOAL_SYSTEM_SESSION_ID="$SESSION_ID" GOAL_SYSTEM_CWD="$PWD" goalctl checkpoint --done "Saved progress"`;
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || String(value).startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgv(argv) {
  if (argv.includes("--self-test")) {
    return { command: "self-test", input: {}, options: {} };
  }

  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", input: {}, options: {} };
  }

  const input = {};
  const options = {
    json: false,
    readStdin: false,
    replaceExisting: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--stdin") {
      options.readStdin = true;
    } else if (arg === "--replace-existing") {
      options.replaceExisting = true;
      input.replaceExisting = true;
    } else if (arg === "--clear-remaining") {
      input.remaining = [];
    } else if (scalarFlagMap.has(arg)) {
      const key = scalarFlagMap.get(arg);
      input[key] = readFlagValue(argv, index, arg);
      index += 1;
    } else if (listFlagMap.has(arg)) {
      const key = listFlagMap.get(arg);
      input[key] = Array.isArray(input[key]) ? input[key] : [];
      input[key].push(readFlagValue(argv, index, arg));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, input, options };
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim();
}

async function parseJsonInput(raw, label) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

async function mergeStructuredInput(input, options) {
  let merged = { ...input };
  if (input.inputJson) {
    const parsed = await parseJsonInput(input.inputJson, "--input-json");
    delete merged.inputJson;
    merged = { ...parsed, ...merged };
  }
  if (options.readStdin) {
    const parsed = await parseJsonInput(await readStdin(), "--stdin");
    merged = { ...parsed, ...merged };
  }
  return merged;
}

function copilotRootForInput(input) {
  if (process.env.COPILOT_HOME) return path.resolve(process.env.COPILOT_HOME);
  const home = input.home ? path.resolve(String(input.home)) : os.homedir();
  return path.join(home, ".copilot");
}

async function createStore(input) {
  const copilotRoot = copilotRootForInput(input);
  const store = new GoalStore({
    stateRoot: input.stateRoot || process.env.GOAL_SYSTEM_STATE_ROOT || path.join(copilotRoot, "session-state", "goal-system"),
    workspaceStateRoot: input.workspaceStateRoot || path.join(copilotRoot, "session-state"),
  });
  await store.init();
  return store;
}

function explicitSessionId(input) {
  const raw = input.sessionId || process.env.GOAL_SYSTEM_SESSION_ID || "";
  if (!raw) return "";
  const sessionId = safeSessionId(raw);
  return sessionId && sessionId !== "unknown-session" ? sessionId : "";
}

function inputCwd(input) {
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

async function contextFromInput(store, input, options = {}) {
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
      `Multiple active goals exist for this working directory. Pass --session-id explicitly. Open sessions: ${sessions.join("; ")}`
    );
  }

  if (allowMissingSession) return { sessionId: "", cwd, inferred: false, record: null };
  throw new Error(
    "A session id is required unless exactly one active goal exists for the current working directory. Pass --session-id from the hook context, set GOAL_SYSTEM_SESSION_ID, or run goalctl from the target workspace."
  );
}

function patchFromInput(input) {
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

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.text}\n`);
}

async function handleStatus(store, input, options) {
  const { sessionId, cwd, record: inferredRecord } = await contextFromInput(store, input, { allowMissingSession: true });
  const record = inferredRecord || (sessionId ? await store.loadGoalRecord(sessionId, cwd) : null);
  if (!record || !isOpenGoal(record.goal)) {
    printResult({ ok: true, text: "No persisted active goal is stored for this workspace.", goal: null }, options.json);
    return;
  }
  printResult({ ok: true, text: formatGoalSummary(record.goal, { includeHistory: true }), goal: record.goal }, options.json);
}

async function handleOpen(store, input, options) {
  const sessionId = explicitSessionId(input);
  if (!sessionId) throw new Error("open requires --session-id from the hook context.");
  const cwd = inputCwd(input);
  const patch = patchFromInput(input);
  if (!patch.objective) throw new Error("open requires --objective or inputJson.objective.");

  let replaced = false;
  const persisted = await store.mutateGoalRecord(sessionId, cwd, (existingGoal) => {
    if (isOpenGoal(existingGoal) && input.replaceExisting !== true) {
      throw new Error(
        "An active persisted goal already exists for this session/workspace. Use checkpoint/update, or pass --replace-existing only when the prompt clearly replaces the current goal."
      );
    }
    replaced = isOpenGoal(existingGoal);
    return createGoalRecord(patch, sessionId, cwd, {
      sourcePrompt: patch.sourcePrompt,
      historyNote: patch.historyNote || "Goal opened or replaced from goalctl",
    });
  });

  store.auditLog("goalctl_open", { sid: sessionId, id: persisted.id, replaced });
  const warning = otherOpenGoalWarning(await store.loadWorkspaceGoalCandidates(cwd), persisted);
  printResult({ ok: true, text: `${formatGoalSummary(persisted)}${warning}`, goal: persisted }, options.json);
}

async function handleUpdate(store, input, options, label = "update") {
  const { sessionId, cwd } = await contextFromInput(store, input);
  if (typeof input.completionStatus === "string" && !MUTABLE_GOAL_STATUSES.includes(input.completionStatus)) {
    throw new Error("checkpoint/update cannot mark a goal complete or cancelled. Use finish/close after verification.");
  }

  const patch = patchFromInput(input);
  const changedFields = Object.keys(patch).filter((key) => !["historyNote", "sourcePrompt"].includes(key) && patch[key] !== undefined);
  if (!changedFields.length) {
    throw new Error("checkpoint/update requires at least one real state field such as done, next/remaining, blocker, evidence/inspection, verify/verification, or input JSON.");
  }

  const persisted = await store.mutateGoalRecord(sessionId, cwd, (goal) => {
    if (!goal) throw new Error("No persisted goal exists yet. Use open first.");
    if (!isOpenGoal(goal)) throw new Error("The persisted goal is already closed. Open a new goal only for an explicit replacement.");

    const checkpointPatch = { ...patch };
    if (label === "checkpoint" && goal.completionStatus === "draft" && checkpointPatch.completionStatus === undefined) {
      checkpointPatch.completionStatus = "active";
    }

    return mergeGoal(goal, checkpointPatch, "update", checkpointPatch.historyNote || (label === "checkpoint" ? "Checkpoint saved from goalctl" : "Goal state updated from goalctl"));
  });

  store.auditLog("goalctl_update", { sid: sessionId, id: persisted.id, fields: changedFields });
  const prefix = label === "checkpoint" ? "Checkpoint saved.\n" : "";
  printResult({ ok: true, action: label, text: `${prefix}${formatGoalSummary(persisted)}`, goal: persisted }, options.json);
}

async function handleClose(store, input, options, label = "close") {
  const { sessionId, cwd } = await contextFromInput(store, input);
  const patch = patchFromInput(input);
  if (!GOAL_STATUSES.includes(patch.completionStatus) || patch.completionStatus === "draft" || patch.completionStatus === "active") {
    throw new Error("close requires --status complete, blocked, or cancelled. Agent-friendly aliases are finish, block, and cancel.");
  }

  const persisted = await store.mutateGoalRecord(sessionId, cwd, (goal) => {
    if (!goal) throw new Error("No persisted goal exists yet, so there is nothing to close.");

    if (label === "finish") {
      const remainingProvided = Array.isArray(input.remaining);
      const priorRemaining = normalizeUniqueList(goal.remaining);
      if (!remainingProvided && priorRemaining.length) {
        throw new Error(
          `Refusing to finish the goal. Remaining work is still recorded: ${priorRemaining.join(" | ")}. Resolve it, then run goalctl finish again with --clear-remaining (or --remaining/--next explicitly), or move it into blockers/issueResolutions first.`
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
      patch.summary || `Goal marked ${patch.completionStatus} from goalctl`
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

  store.auditLog("goalctl_close", { sid: sessionId, id: persisted.id, status: patch.completionStatus });
  const prefix =
    label === "finish" ? "Goal finished.\n" :
      label === "block" ? "Goal blocked.\n" :
        label === "cancel" ? "Goal cancelled.\n" :
          "";
  printResult({ ok: true, action: label, text: `${prefix}${formatGoalSummary(persisted, { includeHistory: false })}`, goal: persisted }, options.json);
}

async function main() {
  const { command, input: rawInput, options } = parseArgv(process.argv.slice(2));
  if (command === "self-test") {
    process.stdout.write("copilot-goal-system goalctl ready\n");
    return;
  }
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const input = await mergeStructuredInput(rawInput, options);
  if (command === "finish" && !input.completionStatus) input.completionStatus = "complete";
  if (command === "block" && !input.completionStatus) input.completionStatus = "blocked";
  if (command === "cancel" && !input.completionStatus) input.completionStatus = "cancelled";
  const store = await createStore(input);

  if (command === "status") await handleStatus(store, input, options);
  else if (command === "open") await handleOpen(store, input, options);
  else if (command === "checkpoint") await handleUpdate(store, input, options, "checkpoint");
  else if (command === "update") await handleUpdate(store, input, options);
  else if (command === "finish") await handleClose(store, input, options, "finish");
  else if (command === "block") await handleClose(store, input, options, "block");
  else if (command === "cancel") await handleClose(store, input, options, "cancel");
  else if (command === "close") await handleClose(store, input, options);
  else throw new Error(`Unknown command "${command}".\n${usage()}`);
}

const wantsJsonOutput = process.argv.slice(2).includes("--json");

main().catch((error) => {
  const message = error?.message || String(error);
  process.stderr.write(`${message}\n`);
  if (wantsJsonOutput) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  }
  process.exitCode = 1;
});
