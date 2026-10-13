# sprites MCP server

Exposes the desk-sprites scene (two pixel knights on your real desk) to an AI
agent over MCP. Streamable HTTP, stateless: `POST http://<this-mac>:3001/mcp`.

## Run

```bash
cd mcp-server && npm install
node server.js            # or use the repo root ./startserver
```

Requires `node server.js -env local` (repo root, port 8447) to be running —
that's the relay the bridge talks to. The scene page (`sprites.html`) and the
desk service (`python/realsense_desk_service.py`) should also be running for
live state.

## Tools

| tool | what it does |
|---|---|
| `list_characters` | the two knights + live pos/anim/speech |
| `spawn_character {character, x?, y?}` | make a knight appear (optionally at a position) |
| `say {character, text, duration_s?}` | speech bubble above the knight |
| `play_animation {character, name}` | one of 16 animations (idle, walk, run, attack, ...) |
| `move_to {character, x, y}` | walk to a desk position (auto walk-anim, steers around obstacles) |
| `get_desk_map` | live desk plane + play-area status |
| `query_obstacles` | physical objects on the desk as boxes — story props |
| `get_scene_state` | confirm actions happened (the agent's feedback loop) |
| `wait {seconds}` | pacing — server-side sleep |

Coordinates: desk-plane millimeters, origin = center of the 60×60 cm play ROI,
+x = user's right, +y = away from the user (range ≈ -300..300).

Writes are **queued** (pushed to the scene over the ws relay); the agent
confirms with `get_scene_state`.

## Connect from the Raspberry Pi

On the Pi (with `claude` installed):

```bash
claude mcp add --transport http sprites http://<mac-LAN-IP>:3001/mcp
```

Accept the macOS firewall prompt for `node` on port 3001 the first time.

## Test without an agent

```bash
npx @modelcontextprotocol/inspector node server.js
```
