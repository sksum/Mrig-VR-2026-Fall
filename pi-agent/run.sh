#!/usr/bin/env bash
#
# run.sh — Desk Knights storytelling loop (runs on the Raspberry Pi).
#
# Each iteration = one "chapter": headless claude with the system prompt +
# sprites MCP server + a randomly picked story seed. Pacing inside a chapter
# is enforced by the system prompt + the MCP `wait` tool; between chapters we
# enforce a hard 10s floor here.
#
# Setup: edit mcp.json to point at your Mac's LAN IP first.

set -u
cd "$(dirname "$0")"

PAUSE_BETWEEN_CHAPTERS="${PAUSE_BETWEEN_CHAPTERS:-10}"
CHAPTERS="${CHAPTERS:-0}"    # 0 = run forever

SEEDS_FILE="story-seeds.md"
PROMPT_FILE="SYSTEM_PROMPT.md"

[ -f mcp.json ] || { echo "mcp.json missing"; exit 1; }
grep -q REPLACE-WITH-MAC-LAN-IP mcp.json && {
  echo "ERROR: edit mcp.json and replace REPLACE-WITH-MAC-LAN-IP with your Mac's LAN IP"
  exit 1
}

n=0
while : ; do
  n=$((n+1))
  # pick a random numbered seed line
  SEED=$(grep -E '^[0-9]+\.' "$SEEDS_FILE" | shuf -n 1 | sed 's/^[0-9]*\. //')
  echo "=== chapter $n: $SEED"

  claude -p \
    --mcp-config mcp.json \
    --system-prompt "$(cat "$PROMPT_FILE")" \
    --allowedTools 'mcp__sprites__*' \
    "Perform one complete chapter of the Desk Knights story. Story premise for this chapter: $SEED

Follow the pacing rules exactly: wait(10) between every scene action, confirm with get_scene_state, and end with a narrator summary."

  [ "$CHAPTERS" -gt 0 ] && [ "$n" -ge "$CHAPTERS" ] && break
  echo "=== chapter $n done; pausing ${PAUSE_BETWEEN_CHAPTERS}s"
  sleep "$PAUSE_BETWEEN_CHAPTERS"
done
