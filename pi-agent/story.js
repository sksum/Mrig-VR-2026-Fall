#!/usr/bin/env node
/*
 * story.js — direct story player for the Desk Knights (no LLM).
 *
 * Plays a long scripted chapter straight over the ws relay (server.js :8447),
 * one beat every 2 seconds: dialogue, every animation in the book, random
 * ground movement, and occasional jump arcs into the air.
 *
 *   node pi-agent/story.js            # plays the chapter, then loops the finale
 *   BEAT_MS=1500 node pi-agent/story.js
 */

const WebSocket = require('ws');

const TAG = '[story]';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), TAG, ...a);

const BEAT_MS = Number(process.env.BEAT_MS) || 2000;
const URL = process.env.SCENE_WS_URL || 'wss://localhost:8447';
const CMD_SLOTS = [1101, 1102, 1103, 1104, 1105, 1106];
const STEEL = 0, COPPER = 1;

// ---------------------------------------------------------------------------
// ws plumbing (same protocol as the MCP bridge)
// ---------------------------------------------------------------------------

let ws = null, slot = 0, inited = new Set(), startedAt = Date.now();

const connect = () => new Promise((resolve, reject) => {
   ws = new WebSocket(URL, { rejectUnauthorized: false });
   ws.on('open', resolve);
   ws.on('error', (e) => { log('ws error:', e.message); setTimeout(() => connect().then(resolve).catch(() => {}), 2000); });
});

const send = (char, cmd, args = {}) => {
   if (!ws || ws.readyState !== WebSocket.OPEN) { log('ws not open, beat dropped'); return; }
   const id = CMD_SLOTS[slot % CMD_SLOTS.length]; slot++;
   const state = { type: 'spriteCmd', char, cmd, args };
   if (!inited.has(id)) {
      ws.send(JSON.stringify({ type: 'objectInit', ts: Date.now(), uid: 'story-js', state: { objid: id, ...state } }));
      inited.add(id);
   } else {
      ws.send(JSON.stringify({ type: 'object', ts: Date.now(), uid: 'story-js', id, state }));
   }
   log(`-> char${char} ${cmd} ${JSON.stringify(args)}`);
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const rnd = (a, b) => a + Math.random() * (b - a);
const ground = () => [Math.round(rnd(-260, 260)), Math.round(rnd(-200, 200)), 0];

// all 16 animations, story order (walk is used by movement automatically)
const ANIMS = ['idle', 'think', 'wave', 'cheer', 'drink', 'inspect', 'tired',
   'block', 'kneel', 'sit', 'sleep', 'sneak', 'run', 'attack', 'defeated', 'walk'];

// A beat: one char does 1-3 things at once (say + anim + move).
// say/anim/move keys are all optional.
const B = (c, o = {}) => ({ c, ...o });
const jump = (c) => {            // dramatic arc: up, then back down
   const [x, y] = ground();
   return [
      B(c, { move: [x, y, 320], anim: 'cheer' }),
      B(c, { move: [x, y, 0] }),
   ];
};

// ---------------------------------------------------------------------------
// the story — long, dialogue-heavy, uses every animation
// ---------------------------------------------------------------------------

const story = [
   // ---- opening: the accusation
   B(STEEL,   { say: 'HARK! Who drinks from MY satchel?!', anim: 'think' }),
   B(COPPER,  { say: 'Twas not I, brother!', anim: 'wave' }),
   B(STEEL,   { say: 'Thy breath smells of honeyed mead...', anim: 'inspect' }),
   B(COPPER,  { say: 'A curse! A curse upon thy nose!', anim: 'attack', move: ground() }),
   ...jump(STEEL),
   B(STEEL,   { say: 'Draw thy blade, mead-thief!', anim: 'block' }),
   B(COPPER,  { say: 'I fear no steel! I fear no stern!', anim: 'cheer' }),

   // ---- the chase (random ground moves, running/sneaking)
   B(COPPER,  { say: 'Catch me first, slowpoke!', anim: 'run', move: ground() }),
   B(STEEL,   { anim: 'run', move: ground() }),
   B(COPPER,  { anim: 'sneak', move: ground(), say: 'Hehe, tiptoe...' }),
   B(STEEL,   { anim: 'run', move: ground() }),
   B(COPPER,  { anim: 'tired', say: '*wheeze* ...halt... truce?' }),
   B(STEEL,   { anim: 'tired', say: 'Never... *puff* ...MEAD-THIEF!' }),
   B(COPPER,  { anim: 'run', move: ground() }),
   B(STEEL,   { anim: 'sneak', move: ground() }),
   ...jump(COPPER),
   B(COPPER,  { say: 'Behold! I can FLY!', anim: 'cheer' }),
   B(STEEL,   { say: 'That is cheating AND heresy.', anim: 'think' }),

   // ---- negotiations
   B(STEEL,   { say: 'Return the potion, and no harm.', anim: 'kneel' }),
   B(COPPER,  { say: 'It gave me... visions. Of dancing turnips.', anim: 'drink' }),
   B(STEEL,   { say: 'TURNIPS?! Now I want it back twice.', anim: 'wave' }),
   B(COPPER,  { say: 'Let us duel for it. Sky rules!', anim: 'block' }),
   B(STEEL,   { say: 'SKY RULES?! Very well. En garde!', anim: 'attack', move: [-80, 0, 0] }),
   B(COPPER,  { anim: 'block', move: [80, 0, 0] }),

   // ---- the duel (attack/block exchanges + jumps)
   B(STEEL,   { anim: 'attack', say: 'HYAAH!' }),
   B(COPPER,  { anim: 'block', say: 'CLANG! Is that all?' }),
   B(COPPER,  { anim: 'attack', say: 'My turn!' }),
   B(STEEL,   { anim: 'block', say: 'Merely a tickle!' }),
   ...jump(STEEL),
   B(STEEL,   { anim: 'attack', say: 'DEATH FROM ABOVE!' }),
   B(COPPER,  { anim: 'block', say: 'Oof! Rude!' }),
   ...jump(COPPER),
   B(COPPER,  { anim: 'attack', say: 'TASTE COPPER!' }),
   B(STEEL,   { anim: 'defeated', say: 'Alas... the mead... wins...' }),
   B(COPPER,  { anim: 'cheer', say: 'VICTORY IS MINE!' }),
   B(STEEL,   { anim: 'defeated' }),
   B(COPPER,  { anim: 'cheer' }),

   // ---- reconciliation
   B(COPPER,  { say: '...Brother? Thou art quiet.', anim: 'think' }),
   B(STEEL,   { anim: 'sit', say: 'I but mourned my potion.' }),
   B(COPPER,  { say: 'There is... one drop left. Share it?', anim: 'inspect' }),
   B(STEEL,   { anim: 'cheer', say: 'Bless thee, sweet Copper!' }),
   B(COPPER,  { anim: 'drink', say: 'To knightly brotherhood!' }),
   B(STEEL,   { anim: 'drink', say: 'To turnip visions!' }),
   ...jump(STEEL), ...jump(COPPER),

   // ---- the feast wind-down (uses every remaining animation)
   B(STEEL,   { anim: 'wave', say: 'Good show, old friend!' }),
   B(COPPER,  { anim: 'wave' }),
   B(STEEL,   { anim: 'idle', move: ground() }),
   B(COPPER,  { anim: 'run', move: ground() }),
   B(STEEL,   { anim: 'sneak', say: 'One last race to the edge?' }),
   B(COPPER,  { anim: 'run', move: ground(), say: 'READY! GO!' }),
   B(STEEL,   { anim: 'run', move: ground() }),
   B(COPPER,  { anim: 'tired' }),
   B(STEEL,   { anim: 'cheer', say: 'I WIN! ...where is my prize?' }),
   B(COPPER,  { anim: 'sleep', say: 'Zzz... no prize... zzz' }),
   B(STEEL,   { anim: 'think', say: 'He sleeps. The perfect crime.' }),
   B(STEEL,   { anim: 'sneak', move: ground() }),
   B(COPPER,  { anim: 'defeated', say: 'Not... the satchel... again...' }),
   B(STEEL,   { anim: 'run', move: ground(), say: 'MINE NOW! AHAHA!' }),
   B(COPPER,  { anim: 'kneel', say: 'The wheel of fate turns...' }),

   // ---- finale
   B(STEEL,   { anim: 'sit' }),
   B(COPPER,  { anim: 'sit' }),
   B(STEEL,   { say: 'And so ends the Tale of the Stolen Mead.' }),
   B(COPPER,  { say: 'Fin! Applause may follow.' }),
   B(STEEL,   { anim: 'cheer' }),
   B(COPPER,  { anim: 'cheer' }),
];

// finale loop: ambient celebration until killed
const finaleLoop = () => {
   const c = Math.random() < .5 ? STEEL : COPPER;
   const anim = ['cheer', 'wave', 'drink', 'idle', 'inspect'][Math.floor(Math.random() * 5)];
   const [x, y] = ground();
   send(c, 'move_to', { x, y, z: Math.random() < .15 ? 250 : 0 });   // occasional jump
   send(c, 'play_animation', { name: anim });
};

// ---------------------------------------------------------------------------
// play
// ---------------------------------------------------------------------------

(async () => {
   log('connecting to', URL);
   await connect();
   log('connected - starting story:', story.length, 'beats @', BEAT_MS, 'ms');

   // spawn both at their marks
   send(STEEL, 'spawn', { x: -150, y: 0 });
   send(COPPER, 'spawn', { x: 150, y: 0 });

   let i = 0;
   const timer = setInterval(() => {
      if (i < story.length) {
         const b = story[i++];
         if (b.say) send(b.c, 'say', { text: b.say, duration_s: BEAT_MS / 1000 + 1 });
         if (b.anim) send(b.c, 'play_animation', { name: b.anim });
         if (b.move) send(b.c, 'move_to', { x: b.move[0], y: b.move[1], z: b.move[2] || 0 });
         if (!b.say && !b.anim && !b.move) log(`(beat ${i} silent)`);
      } else {
         finaleLoop();
      }
   }, BEAT_MS);

   process.on('SIGINT', () => {
      clearInterval(timer);
      log('story stopped after', ((Date.now() - startedAt) / 1000).toFixed(0) + 's');
      process.exit(0);
   });
})();
