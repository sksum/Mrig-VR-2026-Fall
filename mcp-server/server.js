/*
 * sprites MCP server — exposes the desk-sprites scene to the pi storytelling agent.
 *
 * Streamable HTTP transport, stateless mode:
 *     POST http://<mac-LAN-IP>:3001/mcp
 *
 * Tools:
 *   list_characters / spawn_character / say / play_animation / move_to
 *   get_desk_map / query_obstacles / get_scene_state / wait
 *
 * Coordinate system (same as the scene + desk service):
 *   desk-plane millimeters, origin = center of the 60x60cm play ROI,
 *   +x = user's right, +y = away from the user. Range: roughly -300..300.
 *   Obstacles on the desk (mugs, books, ...) appear as boxes in these coords.
 *
 * Write tools only QUEUE a command; use get_scene_state to confirm it happened.
 */

const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { SceneBridge } = require('./bridge.js');

const PORT = process.env.MCP_PORT || 3001;
const TAG = '[mcp]';
const log = (...a) => console.log(new Date().toISOString(), TAG, ...a);

const CHARACTERS = [
   { id: 0, name: 'Steel Knight', palette: 'steel', description: 'grey armor, gold trim, red scarf' },
   { id: 1, name: 'Copper Knight', palette: 'copper', description: 'copper armor, teal trim, blue scarf' },
];

const ANIMATIONS = [
   'idle', 'walk', 'run', 'sneak', 'think', 'sit', 'sleep', 'tired', 'drink',
   'attack', 'block', 'defeated', 'wave', 'cheer', 'kneel', 'inspect',
];

const COORDS_DOC =
   'Desk-plane millimeters. Origin = center of the 60x60cm play area on the desk. ' +
   '+x = user\'s right, +y = away from the user. Valid range roughly -300..+300 on each axis.';

const bridge = new SceneBridge(process.env.SCENE_WS_URL || 'wss://localhost:8447');

function makeServer() {
   const server = new McpServer(
      { name: 'sprites-desk-scene', version: '1.0.0' },
      { capabilities: { tools: {} } },
   );

   const tool = (name, desc, schema, handler) =>
      server.tool(name, desc, schema, async (args) => {
         log('tool call:', name, JSON.stringify(args));
         try {
            const result = await handler(args);
            return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
         } catch (e) {
            log('tool error:', name, e.message);
            return { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true };
         }
      });

   tool('list_characters',
      'List the two knight characters with their live state (position, animation, speech).',
      {},
      async () => {
         const live = (bridge.spriteState && bridge.spriteState.chars) || [];
         return CHARACTERS.map(c => ({ ...c, live: live.find(s => s.id === c.id) || 'not spawned' }));
      });

   tool('spawn_character',
      'Make a character appear on the desk, optionally at a specific position. Default position is its home spot.',
      {
         character: z.number().int().min(0).max(1).describe('0 = Steel Knight, 1 = Copper Knight'),
         x: z.number().optional().describe('spawn x in mm, ' + COORDS_DOC),
         y: z.number().optional().describe('spawn y in mm, ' + COORDS_DOC),
      },
      async (a) => bridge.sendCommand(a.character, 'spawn', { x: a.x, y: a.y }));

   tool('say',
      'Show a speech bubble above a character for a few seconds. Keep lines short and punchy (max ~2 short sentences).',
      {
         character: z.number().int().min(0).max(1),
         text: z.string().max(120).describe('what the character says'),
         duration_s: z.number().min(1).max(30).optional().describe('how long the bubble stays (default 4.5s)'),
      },
      async (a) => bridge.sendCommand(a.character, 'say', { text: a.text, duration_s: a.duration_s || 4.5 }));

   tool('play_animation',
      'Play one of the knight animations: ' + ANIMATIONS.join(', ') + '.',
      {
         character: z.number().int().min(0).max(1),
         name: z.enum(ANIMATIONS),
      },
      async (a) => bridge.sendCommand(a.character, 'play_animation', { name: a.name }));

   tool('move_to',
      'Move a character through the 3D stage space (auto walk animation, steers around desk obstacles when on the ground). Use z to lift them into the air for dramatic entrances, flights, or duels on high.',
      {
         character: z.number().int().min(0).max(1),
         x: z.number().min(-800).max(800).describe('target x in mm. ' + COORDS_DOC),
         y: z.number().min(-800).max(800).describe('target y in mm. ' + COORDS_DOC),
         z: z.number().min(0).max(800).optional().describe('target height above the stage plane in mm (0 = on the desk, 300 = floating mid-air)'),
      },
      async (a) => bridge.sendCommand(a.character, 'move_to', { x: a.x, y: a.y, z: a.z || 0 }));

   tool('get_desk_map',
      'Get the live desk map: play-area size, detected desk plane, and connection status. Obstacles are listed separately by query_obstacles.',
      {},
      async () => bridge.deskMap || { status: 'none', note: 'no deskMap yet - is the desk service running? (python/realsense_desk_service.py)' });

   tool('query_obstacles',
      'List physical objects detected on the desk (mugs, books, ...) as boxes in play-area mm coords: {id, x, y, w, h, heightMm}. Use them as story props - a mug can be a boulder, a book a castle wall. heightMm is how tall the object is.',
      {},
      async () => {
         if (!bridge.deskMap) return { obstacles: [], note: 'no deskMap yet' };
         return { obstacles: bridge.deskMap.obstacles || [], coords: COORDS_DOC };
      });

   tool('get_scene_state',
      'Read the live scene state (positions, animations, speech, movement of both characters + connection health). Call this AFTER each action to confirm it happened before continuing the story.',
      {},
      async () => ({ chars: (bridge.spriteState && bridge.spriteState.chars) || [], bridge: bridge.status() }));

   tool('wait',
      'Wait N seconds. MANDATORY PACING: call wait(4) between every scene action so beats change every ~4 seconds.',
      {
         seconds: z.number().min(1).max(120).describe('seconds to pause (use 4 between actions)'),
      },
      async (a) => {
         log('waiting', a.seconds, 's');
         await new Promise(r => setTimeout(r, a.seconds * 1000));
         return { waited: a.seconds + 's', hint: 'now confirm the last action with get_scene_state' };
      });

   return server;
}

// ---- stateless streamable HTTP: one transport per request ------------------

const server = http.createServer(async (req, res) => {
   if (req.url !== '/mcp') {
      res.writeHead(404).end('not found - POST /mcp');
      return;
   }

   if (req.method === 'GET') {
      // stateless mode: no SSE stream for server-initiated messages
      res.writeHead(405).end('stateless MCP server - use POST');
      return;
   }

   // read body
   let body = '';
   for await (const chunk of req) body += chunk;
   let parsed;
   try { parsed = JSON.parse(body); } catch (e) {
      res.writeHead(400).end('bad JSON');
      return;
   }
   req.body = parsed;

   try {
      const mcp = makeServer();
      const transport = new StreamableHTTPServerTransport({
         sessionIdGenerator: undefined,   // stateless
         enableJsonResponse: true,
      });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
   } catch (e) {
      log('request error:', e.message);
      if (!res.headersSent) res.writeHead(500).end('internal error');
   }
});

server.listen(PORT, '0.0.0.0', () => {
   log(`sprites MCP server listening on http://0.0.0.0:${PORT}/mcp (stateless streamable HTTP)`);
   log('bridge ->', bridge.url);
});
