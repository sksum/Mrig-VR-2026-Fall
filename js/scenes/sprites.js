/*
 * sprites scene — two pixel knights living on your real desk.
 *
 * - Characters are billboard quads textured by live canvases (Knight Errant port,
 *   js/scenes/sprites/knight.js). They can say / animate / move on the desk.
 * - The desk play area (fixed 60x60 cm ROI) + obstacles come from the python
 *   desk service via server.js DataStore (spritebus).
 * - Commands come from the MCP bridge (spritebus "spriteCmd" objects), so the
 *   pi agent drives the whole lifecycle.
 *
 * Coordinate system (shared with the desk service + MCP tools):
 *   ROI mm, origin = ROI center, +x right, +y away from the user.
 *   World placement via DESK_TRANSFORM below (calibrate once per setup),
 *   or live: pull left/right trigger to plant the stage at the controller.
 */

import { createKnight, ANIMS } from './sprites/knight.js';
import { connect as busConnect } from './sprites/spritebus.js';
import { buttonState, controllerMatrix } from '../render/core/controllerInput.js';

const TAG = '[sprites]';
const log = (...a) => console.log(TAG, ...a);

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DESK_TRANSFORM = {
   position: [0, 0.75, -0.40],   // ROI center in world (m): desk height, in front of user
   yaw: 0,                       // rotation of the desk frame
};

const CHAR_HEIGHT_M = 0.06;      // knight quad height (6 cm — desk-game-piece sized;
                                 // NOTE: identity() clears scale, so the animate loop
                                 // must re-apply .scale() every frame or quads render 2m tall)
const WALK_SPEED_MM = 140;       // mm/s through the air/stage
const CHAR_RADIUS_MM = 25;       // collision radius for obstacle steering
const DEFAULT_ROI_MM = 600;      // fallback when no deskMap has arrived yet
const MOVE_LIMIT_MM = 800;       // free-3D movement bound (x/y around stage, z = height)

const TXTR_SLOT = { char: [1, 2], bubble: [3, 4] };

// ---------------------------------------------------------------------------
// Speech bubble canvas
// ---------------------------------------------------------------------------

function makeBubbleCanvas() {
   const c = document.createElement('canvas');
   c.width = 512; c.height = 256;
   return { canvas: c, g: c.getContext('2d') };
}

function drawBubble(bubble, text) {
   const g = bubble.g, W = 512, H = 256;
   g.clearRect(0, 0, W, H);
   if (!text) return;
   g.font = 'bold 28px monospace';
   g.textAlign = 'center';
   g.textBaseline = 'middle';

   // wrap text into lines of <= 26 chars
   const words = String(text).split(/\s+/);
   const lines = [];
   let line = '';
   for (const w of words) {
      if ((line + ' ' + w).trim().length > 26) { lines.push(line.trim()); line = w; }
      else line += ' ' + w;
   }
   if (line.trim()) lines.push(line.trim());

   // pixel-art bubble: white fill, thick dark outline, little tail
   const bw = Math.min(W - 20, Math.max(...lines.map(l => g.measureText(l).width)) + 60);
   const lh = 34, bh = lines.length * lh + 30;
   const bx = (W - bw) / 2, by = 20;

   g.fillStyle = '#14121a';
   g.fillRect(bx - 6, by - 6, bw + 12, bh + 12);
   g.fillStyle = '#f4efdc';
   g.fillRect(bx, by, bw, bh);
   g.fillStyle = '#14121a';
   g.beginPath();                       // tail pointing down
   g.moveTo(W / 2 - 16, by + bh);
   g.lineTo(W / 2 + 16, by + bh);
   g.lineTo(W / 2, by + bh + 26);
   g.closePath(); g.fill();

   g.fillStyle = '#25222b';
   lines.forEach((l, i) => g.fillText(l, W / 2, by + 20 + i * lh));
}

// ---------------------------------------------------------------------------
// Character state
// ---------------------------------------------------------------------------

function makeChar(i, paletteKey, startX, startY) {
   const knight = createKnight(paletteKey);
   return {
      id: i,
      knight,
      bubble: makeBubbleCanvas(),
      visible: false,
      pos: [startX, startY, 0],    // stage mm: x right, y away, z = height above stage
      target: null,                // stage mm [x,y,z] or null
      anim: 'idle',
      animT: 0,
      flip: false,
      speech: null,
      speechUntil: 0,
      pinnedUntil: 0,       // a commanded animation stays pinned until this time
      nextAmbientAt: 0,     // then ambient random animations resume, one every 4s
   };
}

// ambient pool: lively animations the knights cycle through on their own
const AMBIENT_ANIMS = ['idle', 'think', 'wave', 'cheer', 'drink', 'inspect',
   'tired', 'block', 'kneel', 'sit', 'sleep', 'sneak', 'run'];

// segment vs AABB intersection for steering
function segHitsBox(p, q, box, pad) {
   const x0 = box.x - box.w / 2 - pad, x1 = box.x + box.w / 2 + pad;
   const y0 = box.y - box.h / 2 - pad, y1 = box.y + box.h / 2 + pad;
   // Liang-Barsky clip test
   let t0 = 0, t1 = 1;
   const dx = q[0] - p[0], dy = q[1] - p[1];
   const edges = [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dy, p[1] - y0], [dy, y1 - p[1]]];
   for (const [den, num] of edges) {
      if (den === 0) { if (num < 0) return false; continue; }
      const t = num / den;
      if (den < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
   }
   return true;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export const init = async model => {

   const chars = [
      makeChar(0, 'steel', -150, 0),
      makeChar(1, 'copper', 150, 0),
   ];
   // visible from the start at the default stage position, so something is
   // always on screen; trigger press re-anchors the stage anywhere you point
   chars.forEach(c => { c.visible = true; });

   let deskMap = null;             // latest deskMap from the desk service
   let debugOverlay = false;
   let placed = false;
   let prevTrigger = { left: false, right: false };

   const roiHalf = () => (deskMap && deskMap.roi ? deskMap.roi.widthMm : DEFAULT_ROI_MM) / 2;
   const obstacles = () => (deskMap && deskMap.obstacles) || [];

   const clampMove = p => {
      // free-3D bounds: x/y around the stage, z = height above the stage plane
      const h = MOVE_LIMIT_MM;
      return [
         Math.max(-h, Math.min(h, p[0])),
         Math.max(-h, Math.min(h, p[1])),
         Math.max(0, Math.min(h, p[2] || 0)),
      ];
   };

   // ROI mm -> world m
   const roiToWorld = (x, y, liftM = 0) => {
      const [px, py, pz] = DESK_TRANSFORM.position;
      const yaw = DESK_TRANSFORM.yaw;
      const wx = x / 1000, wz = -y / 1000;         // ROI +y (away) -> world -z
      const rx = wx * Math.cos(yaw) - wz * Math.sin(yaw);
      const rz = wx * Math.sin(yaw) + wz * Math.cos(yaw);
      return [px + rx, py + liftM, pz + rz];
   };

   // ---- build clay nodes -------------------------------------------------

   model.txtrSrc(TXTR_SLOT.char[0], chars[0].knight.canvas);
   model.txtrSrc(TXTR_SLOT.char[1], chars[1].knight.canvas);
   model.txtrSrc(TXTR_SLOT.bubble[0], chars[0].bubble.canvas);
   model.txtrSrc(TXTR_SLOT.bubble[1], chars[1].bubble.canvas);

   const groups = [], charQuads = [], bubbleQuads = [];
   for (let i = 0; i < 2; i++) {
      const group = model.add();
      const cq = group.add('square').scale(CHAR_HEIGHT_M / 2, CHAR_HEIGHT_M / 2, 1)
         .dull().opacity(1).txtr(TXTR_SLOT.char[i]);
      const bq = group.add('square').scale(.09, .045, 1)
         .dull().opacity(0).txtr(TXTR_SLOT.bubble[i]);
      groups.push(group); charQuads.push(cq); bubbleQuads.push(bq);
   }

   // debug overlay nodes (lazily populated per obstacle)
   let roiFrame = null;
   const obstacleNodes = new Map();

   const updateDebugOverlay = () => {
      if (!debugOverlay) return;
      const h = roiHalf() / 1000;
      if (!roiFrame) {
         roiFrame = model.add();
         for (let e = 0; e < 4; e++) roiFrame.add('square').scale(.002, .002, 1).color(1, .3, .2);
      }
      const mids = [[0, -h, h * 2, 0], [0, h, h * 2, 0], [-h, 0, 0, h * 2], [h, 0, 0, h * 2]];
      mids.forEach((m, e) => {
         const [x, y, sx, sy] = m;
         roiFrame.child(e).identity()
            .move(...roiToWorld(x, y, .01))
            .scale(sx || .004, sy || .004, 1);
      });

      const seen = new Set();
      for (const ob of obstacles()) {
         seen.add(ob.id);
         let node = obstacleNodes.get(ob.id);
         if (!node) {
            node = model.add('cube').opacity(.3).color(1, .6, .1);
            obstacleNodes.set(ob.id, node);
         }
         const wh = Math.max(ob.w, 40) / 1000, hd = Math.max(ob.h, 40) / 1000;
         const ht = Math.max(ob.heightMm, 40) / 1000;
         node.identity().move(...roiToWorld(ob.x, ob.y, ht / 2)).scale(wh / 2, ht / 2, hd / 2);
      }
      for (const [id, node] of obstacleNodes) {
         if (!seen.has(id)) { node.scale(0); }
      }
   };

   // ---- commands from MCP ------------------------------------------------

   const applyCommand = (state) => {
      const c = chars[state.char];
      if (!c) { log('command for unknown char', state.char); return; }
      const { cmd, args = {} } = state;
      log('apply', cmd, '-> char', c.id, JSON.stringify(args));
      switch (cmd) {
         case 'spawn':
            // position only applies on FIRST spawn — later spawns keep the
            // knight where it is (consistent position across story beats)
            if (!c.visible) {
               if (typeof args.x === 'number' || typeof args.y === 'number' || typeof args.z === 'number')
                  c.pos = clampMove([Number(args.x) || 0, Number(args.y) || 0, Number(args.z) || 0]);
               c.target = null;
               log(`char ${c.id} spawned at (${c.pos.join(', ')})`);
            } else log(`char ${c.id} already on stage - keeping position`);
            c.visible = true;
            break;
         case 'set_visible':
            c.visible = !!args.visible;
            break;
         case 'say': {
            const text = String(args.text || '').slice(0, 120);
            const dur = Number(args.duration_s) || 4.5;
            c.speech = text;
            c.speechUntil = model.time + dur;
            drawBubble(c.bubble, text);
            log(`char ${c.id} says "${text}" for ${dur}s`);
            break;
         }
         case 'play_animation': {
            const name = ANIMS[args.name] ? args.name : 'idle';
            c.anim = name; c.animT = 0;
            c.pinnedUntil = model.time + 8;   // stays for 8s, then ambient random resumes
            log(`char ${c.id} anim -> ${name}`);
            break;
         }
         case 'move_to': {
            const t = clampMove([Number(args.x) || 0, Number(args.y) || 0, Number(args.z) || 0]);
            c.target = t;
            log(`char ${c.id} move -> (${t.join(', ')})`);
            break;
         }
         default:
            log('unknown cmd', cmd);
      }
   };

   const bus = busConnect({
      onCommand: applyCommand,
      onDeskMap: (m) => { deskMap = m; },
   });

   const relay = (msg) => {
      log(msg);
      try {
         if (window.wsclient?.ws?.readyState === 1)
            window.wsclient.ws.send(JSON.stringify({
               type: 'log', tag: 'sprites', msg: String(msg).slice(0, 300), ts: Date.now()
            }));
      } catch (e) { /* best-effort */ }
   };

   const spawnKnightsOnStage = () => {
      chars[0].pos = clampMove([-150, 0, 0]);
      chars[1].pos = clampMove([150, 0, 0]);
      chars.forEach(c => {
         c.visible = true;
         c.target = null;
         c.anim = 'idle';
         c.animT = 0;
      });
   };

   let lastPlaceAt = -1;
   const placeStageAt = (xyz, source) => {
      if (!xyz || xyz.length < 3 || xyz.some(n => !Number.isFinite(n))) return;
      if (placed) return;            // ONE-SHOT: later triggers must NOT reset positions
      if (model.time - lastPlaceAt < 0.25) return;
      lastPlaceAt = model.time;
      DESK_TRANSFORM.position[0] = xyz[0];
      DESK_TRANSFORM.position[1] = xyz[1];
      DESK_TRANSFORM.position[2] = xyz[2];
      spawnKnightsOnStage();
      placed = true;
      relay(`stage placed via ${source} at ${xyz.map(n => Number(n).toFixed(3)).join(',')} (one-shot; further triggers ignored)`);
   };

   const triggerAimPos = (hand) => {
      // Prefer inputEvents.pos — same space as clay nodes (see interact.js).
      const ie = window.inputEvents?.pos?.(hand);
      if (ie && ie.length >= 3 && Number.isFinite(ie[0])) return ie;
      const m = controllerMatrix[hand];
      if (m && m.length >= 16 && Number.isFinite(m[12]))
         return [m[12], m[13], m[14]];
      return null;
   };

   const tryTriggerPlace = () => {
      for (const hand of ['left', 'right']) {
         const ieDown = !!(window.inputEvents && window.inputEvents.isPressed(hand));
         const btn = buttonState[hand] && buttonState[hand][0];
         const btnDown = !!(btn && btn.pressed);
         const down = ieDown || btnDown;
         if (down && !prevTrigger[hand]) {
            placeStageAt(triggerAimPos(hand), hand + ' trigger');
         }
         prevTrigger[hand] = down;
      }
   };

   if (window.inputEvents) {
      window.inputEvents.onPress = hand => {
         placeStageAt(triggerAimPos(hand), hand + ' trigger');
      };
   }

   log('scene initialized; pull left or right trigger to plant the stage');
   relay('scene initialized; pull left or right trigger to plant the stage');

   // debug toggle
   addEventListener('keydown', e => {
      if (e.key === 'd' || e.key === 'D') {
         debugOverlay = !debugOverlay;
         log('debug overlay', debugOverlay ? 'ON' : 'OFF');
         if (!debugOverlay) { roiFrame?.scale(0); obstacleNodes.forEach(n => n.scale(0)); }
      }
      // flatscreen fallback: T plants the stage in front of the camera/head
      if (e.key === 't' || e.key === 'T') {
         const h = window.clay?.pose?.transform?.position;
         if (h) placeStageAt([h.x, h.y - 0.35, h.z - 0.45], 'keyboard T');
         else placeStageAt([0, 0.75, -0.40], 'keyboard T default');
      }
   });

   // ---- per-frame update -------------------------------------------------

   model.animate(() => {
      const dt = Math.min(.1, model.deltaTime || 1 / 72);
      const head = window.clay?.pose?.transform?.position;
      tryTriggerPlace();

      for (let i = 0; i < 2; i++) {
         const c = chars[i];

         // movement (free 3D: x/y across the stage, z = height)
         if (c.target) {
            const dx = c.target[0] - c.pos[0], dy = c.target[1] - c.pos[1], dz = c.target[2] - c.pos[2];
            const dist = Math.hypot(dx, dy, dz);
            if (dist < WALK_SPEED_MM * dt + 1) {
               log(`char ${c.id} arrived at (${c.target.join(', ')})`);
               c.pos = [...c.target];
               c.target = null;
               if (c.anim === 'walk') { c.anim = 'idle'; c.animT = 0; }
            } else {
               let nx = dx / dist, ny = dy / dist;
               // obstacle steering only when on the ground plane
               if ((c.pos[2] < 50 || c.target[2] < 50) && deskMap && deskMap.status === 'ok') {
                  const blocked = obstacles().find(ob => segHitsBox(c.pos, c.target, ob, CHAR_RADIUS_MM));
                  if (blocked) {
                     const side = ((blocked.x - c.pos[0]) * dy - (blocked.y - c.pos[1]) * dx) > 0 ? -1 : 1;
                     const tx = -ny * side, ty = nx * side;       // perpendicular
                     nx = nx * .4 + tx * .9; ny = ny * .4 + ty * .9;
                     const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
                  }
               }
               const step = WALK_SPEED_MM * dt;
               c.pos[0] += nx * step;
               c.pos[1] += ny * step;
               c.pos[2] += (dz / dist) * step;
               c.pos = clampMove(c.pos);
               if (c.anim !== 'walk') { c.anim = 'walk'; c.animT = 0; }
               if (Math.abs(nx) > .1) c.flip = nx < 0;
            }
         }

         // ambient random animation: when no commanded animation is pinned and
         // the knight isn't walking somewhere, cycle a random anim every 4s
         if (!c.target && model.time > c.pinnedUntil && model.time > c.nextAmbientAt) {
            const pool = AMBIENT_ANIMS.filter(a => a !== c.anim);
            c.anim = pool[(Math.random() * pool.length) | 0];
            c.animT = 0;
            c.nextAmbientAt = model.time + 4;
         }

         // face the other knight while standing still
         if (!c.target) {
            const other = chars[1 - i];
            c.flip = other.pos[0] < c.pos[0];   // sprite faces right by default
         }

         // animation
         c.animT += dt;
         c.knight.drawFrame(c.anim, c.animT, { flip: c.flip });

         // speech expiry
         if (c.speech && model.time > c.speechUntil) {
            c.speech = null;
            drawBubble(c.bubble, null);
            log(`char ${c.id} speech cleared`);
         }

         // place nodes (billboard toward head)
         const lift = c.pos[2] / 1000 + CHAR_HEIGHT_M / 2 + .002;
         const [wx, wy, wz] = roiToWorld(c.pos[0], c.pos[1], lift);
         let yaw = 0;
         if (head) yaw = Math.atan2(head.x - wx, head.z - wz);
         groups[i].identity().move(wx, wy, wz).turnY(-yaw);
         // identity() clears scale -> re-apply every frame
         charQuads[i].identity().scale(CHAR_HEIGHT_M / 2, CHAR_HEIGHT_M / 2, 1)
            .opacity(c.visible ? 1 : 0);

         // speech bubble (3x knight size) above the character
         const hp = c.knight.headPos();                     // 432-space, y from top
         const bw = CHAR_HEIGHT_M * 2.4, bh = CHAR_HEIGHT_M * 1.2;
         const bubbleLift = lift + CHAR_HEIGHT_M * (1 - hp.y / 432) + .04;
         const [bx, by, bz] = roiToWorld(c.pos[0], c.pos[1], bubbleLift);
         bubbleQuads[i].identity().scale(bw / 2, bh / 2, 1)
            .move(bx - wx, by - wy, bz - wz)
            .opacity(c.speech ? 1 : 0);
      }

      updateDebugOverlay();

      // publish state upstream (spritebus throttles to 2 Hz)
      bus.publishState(chars.map(c => ({
         id: c.id,
         visible: c.visible,
         pos: [Math.round(c.pos[0]), Math.round(c.pos[1]), Math.round(c.pos[2])],
         moving: !!c.target,
         anim: c.anim,
         speech: c.speech,
      })));
   });
};

export const deinit = () => {
   log('deinit');
};
