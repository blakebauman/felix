#!/bin/bash
# SubagentStop hook: append a line per completed subagent to a local audit
# trail so humans can review what the AI delegated. Log dir is gitignored.
input=$(cat)
d="${CLAUDE_PROJECT_DIR:-.}/.claude/logs"
mkdir -p "$d" 2>/dev/null || exit 0
{
  printf '%s | session=%s | agent=%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" \
    "$(printf '%s' "$input" | jq -r '.session_id // "?"')" \
    "$(printf '%s' "$input" | jq -r '.agent_type // .subagent_type // .agent_name // "unknown"')"
} >> "$d/subagent-activity.log" 2>/dev/null
exit 0
