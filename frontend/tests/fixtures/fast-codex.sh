#!/bin/sh
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  printf '%s\n' '{"models":[{"slug":"gpt-5.5","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"}]}]}'
  exit 0
fi

cat >/dev/null
printf '%s\n' '{"type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"fast codex complete"}}'
printf '%s\n' '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"fast codex complete"}}'
