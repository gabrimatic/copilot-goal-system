#!/usr/bin/env bash
set -euo pipefail

# Goal-system CLI hook helper.
# Safe by default: if jq or input data is unavailable, it exits quietly.
# The SDK extension owns authoritative state. This hook handles CLI lifecycle
# edges: compact snapshots, subagent boundaries, and stop-time continuation.

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

input=$(cat || true)
[[ -z "$input" ]] && exit 0

if ! printf '%s' "$input" | jq -e type >/dev/null 2>&1; then
  exit 0
fi

jq_get() {
  local filter="$1"
  printf '%s' "$input" | jq -r "$filter // empty" 2>/dev/null || true
}

cwd=$(jq_get '.cwd // .workspace // .workspaceFolder')
session_id=$(jq_get '.sessionId // .session_id')
hook_event=$(jq_get '.hook_event_name // .hookEventName')

[[ -z "$cwd" || -z "$session_id" ]] && exit 0

jq_has() {
  local filter="$1"
  printf '%s' "$input" | jq -e "$filter" >/dev/null 2>&1
}

has_stop_signal() {
  jq_has 'has("stopReason") or has("stop_reason") or has("finishReason") or has("finish_reason") or has("completionReason") or has("completion_reason") or has("terminationReason") or has("termination_reason") or has("stop_hook_active") or has("stopHookActive")'
}

infer_hook_event() {
  if [[ -n "$hook_event" ]]; then
    printf '%s' "$hook_event"
    return
  fi

  if jq_has 'has("trigger") or has("customInstructions") or has("custom_instructions")'; then
    printf 'preCompact'
  elif jq_has 'has("agentName") or has("agent_name")'; then
    if has_stop_signal; then
      printf 'subagentStop'
    else
      printf 'subagentStart'
    fi
  elif has_stop_signal; then
    printf 'agentStop'
  elif jq_has 'has("toolResult") or has("tool_result")'; then
    printf 'postToolUse'
  elif jq_has 'has("error") and (has("toolName") or has("tool_name"))'; then
    printf 'postToolUseFailure'
  elif jq_has 'has("prompt")'; then
    printf 'userPromptSubmitted'
  elif jq_has 'has("notification_type")'; then
    printf 'notification'
  elif jq_has 'has("source") or has("initialPrompt") or has("initial_prompt")'; then
    printf 'sessionStart'
  fi
}

canonical_hook_event() {
  case "$(infer_hook_event)" in
    SessionStart|sessionStart) printf 'sessionStart' ;;
    UserPromptSubmit|UserPromptSubmitted|userPromptSubmitted) printf 'userPromptSubmitted' ;;
    PreCompact|preCompact) printf 'preCompact' ;;
    SubagentStart|subagentStart) printf 'subagentStart' ;;
    SubagentStop|subagentStop) printf 'subagentStop' ;;
    Stop|AgentStop|agentStop) printf 'agentStop' ;;
    Notification|notification) printf 'notification' ;;
    PostToolUseFailure|postToolUseFailure) printf 'postToolUseFailure' ;;
    PostToolUse|postToolUse) printf 'postToolUse' ;;
    *) printf '%s' "$hook_event" ;;
  esac
}

hook_event="$(canonical_hook_event)"

normalize_path() {
  local raw_path="$1"
  if [[ -z "$raw_path" ]]; then
    printf '%s' ""
  elif [[ -d "$raw_path" ]]; then
    (cd "$raw_path" && pwd -P)
  else
    printf '%s' "$raw_path"
  fi
}

safe_session_id() {
  printf '%s' "$1" | sed -E 's/[^A-Za-z0-9_.-]/_/g' | cut -c1-180
}

hash_cwd() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 1 | awk '{print $1}'
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha1sum | awk '{print $1}'
  else
    printf '%s' "$1" | sed -E 's/[^A-Za-z0-9_.-]/_/g' | cut -c1-80
  fi
}

sha256_text() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    hash_cwd "$1"
  fi
}

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

copilot_home="${COPILOT_HOME:-$HOME/.copilot}"
normalized_cwd=$(normalize_path "$cwd")
safe_sid=$(safe_session_id "$session_id")
[[ -z "$safe_sid" ]] && exit 0

state_root="$copilot_home/session-state/goal-system"
workspace_goal_path="$copilot_home/session-state/${safe_sid}/goal-state.json"
session_goal_path="$state_root/by-session/${safe_sid}.json"
cwd_goal_path="$state_root/by-cwd-session/$(hash_cwd "$normalized_cwd")--${safe_sid}.json"

goal_path=""
best_updated_at=""
status=""

for candidate_path in "$workspace_goal_path" "$session_goal_path" "$cwd_goal_path"; do
  [[ -z "$candidate_path" || ! -f "$candidate_path" ]] && continue

  candidate_status=$(jq -r '.completionStatus // empty' "$candidate_path" 2>/dev/null || true)
  candidate_closed_at=$(jq -r '.closedAt // empty' "$candidate_path" 2>/dev/null || true)
  [[ -n "$candidate_closed_at" ]] && continue
  case "$candidate_status" in
    draft|active|blocked) ;;
    *) continue ;;
  esac

  goal_cwd=$(jq -r '.cwd // empty' "$candidate_path" 2>/dev/null || true)
  if [[ -n "$goal_cwd" ]]; then
    normalized_goal_cwd=$(normalize_path "$goal_cwd")
    [[ "$normalized_goal_cwd" != "$normalized_cwd" ]] && continue
  fi

  updated_at=$(jq -r '.updatedAt // .createdAt // empty' "$candidate_path" 2>/dev/null || true)
  if [[ -z "$goal_path" || "$updated_at" > "$best_updated_at" ]]; then
    goal_path="$candidate_path"
    best_updated_at="$updated_at"
    status="$candidate_status"
  fi
done

# Subagents must not receive full goal state. They only receive a hard boundary.
case "$hook_event" in
  subagentStart)
    jq -n --arg additionalContext "Goal mode is main-session only. Do not use goal_system_* tools, do not open or close goals, and do not assume the active goal. Complete only your bounded delegated subtask and return real evidence to the main session." '{additionalContext: $additionalContext}'
    exit 0
    ;;
esac

prompt_text=$(jq_get '.prompt // .message // .userPrompt // .user_prompt')

prompt_matches() {
  local pattern="$1"
  [[ -n "$prompt_text" ]] || return 1
  jq -n -e --arg prompt "$prompt_text" --arg pattern "$pattern" '$prompt | test($pattern; "i")' >/dev/null 2>&1
}

trim_prompt_objective() {
  jq -n -r --arg prompt "$prompt_text" '
    ($prompt
      | gsub("\u0000"; "")
      | sub("^\\s+"; "")
      | sub("\\s+$"; "")
      | sub("^/goal\\b[:\\s-]*"; ""; "i")
      | sub("^new goal\\b[:\\s-]*"; ""; "i")
      | sub("^goal mode\\b[:\\s-]*"; ""; "i")
      | sub("^turn this into a goal\\b[:\\s-]*"; ""; "i")) as $objective
    | if ($objective | length) == 0 then "Goal mode task"
      elif ($objective | length) > 600 then ($objective[0:599])
      else $objective end
  '
}

empty_session_context() {
  cat <<EOF_EMPTY
Goal System for Copilot CLI is available for this main session.
Session ID: $safe_sid
CWD: $normalized_cwd
Use direct goal_system_* tools when available. If direct tools are unavailable, use:
node "$copilot_home/extensions/goal-system/bin/goalctl.mjs" status --session-id "$safe_sid" --cwd "$normalized_cwd"
No MCP server is required or configured by this goal system.
When the prompt explicitly starts goal mode, call goal_system_open with these exact values, or run goalctl open with the same Session ID and CWD. For active goals, use goal_system_status or goalctl status before continuing or closing. Subagents must not use goal tools.
EOF_EMPTY
}

write_goal_json() {
  local destination="$1"
  local payload="$2"
  mkdir -p "$(dirname "$destination")"
  chmod 700 "$(dirname "$destination")" 2>/dev/null || true
  local temp_path="${destination}.tmp-$$"
  printf '%s\n' "$payload" > "$temp_path"
  chmod 600 "$temp_path" 2>/dev/null || true
  mv "$temp_path" "$destination"
  chmod 600 "$destination" 2>/dev/null || true
}

write_private_text() {
  local destination="$1"
  local payload="$2"
  mkdir -p "$(dirname "$destination")"
  chmod 700 "$(dirname "$destination")" 2>/dev/null || true
  local temp_path="${destination}.tmp-$$"
  printf '%s\n' "$payload" > "$temp_path"
  chmod 600 "$temp_path" 2>/dev/null || true
  mv "$temp_path" "$destination"
  chmod 600 "$destination" 2>/dev/null || true
}

create_cli_draft_goal() {
  local objective="$1"
  local timestamp="$2"
  local prompt_hash="$3"
  local goal_id
  if command -v uuidgen >/dev/null 2>&1; then
    goal_id="goal-$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    goal_id="goal-$(sha256_text "${safe_sid}:${normalized_cwd}:${timestamp}" | cut -c1-32)"
  fi

  jq -n \
    --arg id "$goal_id" \
    --arg sessionId "$safe_sid" \
    --arg cwd "$normalized_cwd" \
    --arg objective "$objective" \
    --arg now "$timestamp" \
    --arg promptHash "$prompt_hash" \
    '{
      version: 3,
      id: $id,
      sessionId: $sessionId,
      cwd: $cwd,
      objective: $objective,
      requirements: ["Inspect the real environment before treating any unverified detail as fact."],
      scope: [],
      mustNotRegress: [],
      constraints: [],
      currentEnvironment: [],
      requiredTools: [],
      validationProof: [],
      verificationResults: [],
      requirementCoverage: [],
      inspectionEvidence: [],
      discoveredIssues: [],
      resolvedIssues: [],
      issueResolutions: [],
      doneSoFar: ["Draft goal record created from the explicit goal-mode prompt."],
      remaining: [
        "Inspect the real environment and replace draft fields with verified facts.",
        "Execute the goal, record discovered issues, fix them, verify with evidence, and close only after audit."
      ],
      blockers: [],
      completionAudit: [],
      completionStatus: "draft",
      sourcePromptHash: $promptHash,
      sourcePromptPreview: $objective,
      createdAt: $now,
      updatedAt: $now,
      history: [{ at: $now, type: "open", note: "CLI draft goal created automatically from explicit activation prompt" }]
    }'
}

if [[ -z "$goal_path" ]]; then
  case "$hook_event" in
    sessionStart)
      jq -n --arg additionalContext "$(empty_session_context)" '{additionalContext: $additionalContext}'
      exit 0
      ;;
    userPromptSubmitted)
      continue_pattern='(^|[[:space:]])(continue the active goal|continue goal|resume goal|what remains|keep going|go on|continue from goal state)($|[[:space:]])'
      activation_pattern='(^|[[:space:]\(\["`])/goal\b|\b(new goal|goal mode|turn this into a goal|keep working until this is done|make sure everything is fixed|no escape|do it fully|polish everything|deeply inspect and fix|verify and prove it|reach perfection|nothing left behind)\b'
      if prompt_matches "$activation_pattern" && ! prompt_matches "$continue_pattern"; then
        objective=$(trim_prompt_objective)
        timestamp=$(now_iso)
        prompt_hash=$(sha256_text "$prompt_text")
        draft_json=$(create_cli_draft_goal "$objective" "$timestamp" "$prompt_hash")
        write_goal_json "$session_goal_path" "$draft_json"
        write_goal_json "$workspace_goal_path" "$draft_json"
        write_goal_json "$cwd_goal_path" "$draft_json"
        activation_context=$(cat <<EOF_ACTIVATION
A persisted draft goal was created for this Copilot CLI main session.
Goal ID: $(printf '%s' "$draft_json" | jq -r '.id')
Session ID: $safe_sid
CWD: $normalized_cwd
Objective: $objective
Use direct goal_system_* tools when available. If direct tools are unavailable, use local goalctl with the exact Session ID and CWD above.
Inspect the real environment before treating any detail as fact, then call goal_system_update with verified facts before doing substantive work.
Do not answer with only an acknowledgment. Continue the real task and close only after proof.
EOF_ACTIVATION
)
        jq -n --arg additionalContext "$activation_context" '{additionalContext: $additionalContext}'
        exit 0
      fi
      jq -n --arg additionalContext "$(empty_session_context)" '{additionalContext: $additionalContext}'
      exit 0
      ;;
  esac
  exit 0
fi

join_list() {
  local key="$1"
  jq -r --arg key "$key" '
    .[$key] // []
    | map(select(type == "string" and . != ""))
    | .[:4]
    | if length == 0 then "none" else join(" | ") end
  ' "$goal_path" 2>/dev/null || printf 'none'
}

goal_id=$(jq -r '.id // "unknown"' "$goal_path")
objective=$(jq -r '.objective // "unknown until inspected"' "$goal_path")
remaining=$(join_list 'remaining')
done_so_far=$(join_list 'doneSoFar')
blockers=$(join_list 'blockers')
validation=$(join_list 'validationProof')
updated_at=$(jq -r '.updatedAt // .createdAt // "unknown"' "$goal_path")

context=$(cat <<EOF_CONTEXT
Open persisted main-session goal for this working directory.
Goal ID: $goal_id
Session ID: $safe_sid
CWD: $normalized_cwd
Status: $status
Objective: $objective
Done so far: $done_so_far
Remaining: $remaining
Blockers: $blockers
Validation/proof: $validation
Updated at: $updated_at
Use direct goal_system_* tools when available. If direct tools are unavailable, use local goalctl with the Session ID and CWD above. Use goal_system_status or goalctl status for authoritative state before continuing or closing. Do not mark complete without real inspection evidence, resolved issues, verification results, and completion audit.
EOF_CONTEXT
)

case "$hook_event" in
  preCompact)
    compact_dir="$state_root/compact"
    write_private_text "$compact_dir/${safe_sid}.txt" "$context" || true
    exit 0
    ;;
  agentStop)
    reason=$(cat <<EOF_REASON
Active persisted goal is still open for this main session.
Goal ID: $goal_id
Session ID: $safe_sid
CWD: $normalized_cwd
Objective: $objective
Status: $status
Remaining: $remaining
Blockers: $blockers

This is a hard continuation directive. Do not produce a final answer, do not ask for permission to continue, and do not bypass the guard by copying unresolved issue text into resolvedIssues.
Use direct goal_system_* tools when available. If direct tools are unavailable, use local goalctl with the exact Session ID and CWD above.
Your next actions must be:
1. Call goal_system_status, or run goalctl status, to reload authoritative state.
2. Continue the next concrete remaining item. If remaining is empty but the goal is open, inspect the real state and update remaining or close with evidence.
3. Call goal_system_update, or run goalctl update, after meaningful inspection, fixes, blockers, verification, or remaining-work changes.
4. Call goal_system_close, or run goalctl close, only when completion, blockage, or cancellation is supported by exact evidence and the completion audit passes.
EOF_REASON
)
    jq -n --arg reason "$reason" '{decision: "block", reason: $reason}'
    exit 0
    ;;
  postToolUseFailure)
    jq -n --arg additionalContext "A tool failed while a persisted goal is active. Record the failure or blocker in goal_system_update if it affects the goal, then continue from evidence." '{additionalContext: $additionalContext}'
    exit 0
    ;;
  sessionStart|userPromptSubmitted|notification)
    jq -n --arg additionalContext "$context" '{additionalContext: $additionalContext}'
    exit 0
    ;;
  subagentStop)
    jq -n '{decision: "allow"}'
    exit 0
    ;;
  *)
    # Unknown hook event. Be conservative and quiet.
    exit 0
    ;;
esac
