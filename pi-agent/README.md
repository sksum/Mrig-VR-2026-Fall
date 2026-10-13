# pi-agent — Desk Knights storyteller

Runs on the Raspberry Pi next to the desk. Each loop iteration performs one
"chapter" of an improvised story with the two knights, driven through the
sprites MCP server on the Mac.

## Files

- `SYSTEM_PROMPT.md` — the narrator persona, stage rules, mandatory pacing
- `story-seeds.md` — premises, one picked at random per chapter
- `mcp.json` — MCP config pointing at the Mac
- `run.sh` — the chapter loop

## Setup (on the Pi)

1. Install Claude Code on the Pi (`npm install -g @anthropic-ai/claude-code`)
   and log in once (`claude` → follow auth).
2. Copy this directory to the Pi (`scp -r pi-agent pi@<pi-ip>:~`).
3. Edit `mcp.json`: replace `REPLACE-WITH-MAC-LAN-IP` with your Mac's LAN IP.
4. On the Mac: start everything with `./startserver` (repo root), open
   `sprites.html` in the headset browser.
5. On the Pi: `chmod +x run.sh && ./run.sh`

## Controls

- `CHAPTERS=3 ./run.sh` — stop after 3 chapters (default: forever)
- `PAUSE_BETWEEN_CHAPTERS=30 ./run.sh` — longer gap between chapters

## Dry-run on the Mac (no Pi needed)

```bash
cd pi-agent
sed 's/REPLACE-WITH-MAC-LAN-IP/localhost/' mcp.json > mcp.local.json
claude -p --mcp-config mcp.local.json --system-prompt "$(cat SYSTEM_PROMPT.md)" \
   --allowedTools 'mcp__sprites__*' "Perform one short test chapter"
```
