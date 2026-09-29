/*
   HOMEWORK 2: VR BOXING — punch the floating faces.

   Golden gloves (Meshy GLB, mirrored copy for the right hand) are attached
   to both controllers. During a 2 minute round, 3 photos of the author's
   face float in the air. Punching one shatters it mirror-shard style and
   scores +20.

   Right trigger starts the round. 3-2-1-GO countdown and the time/score
   HUD are rendered with linefont.
*/

import * as cg from "../render/core/cg.js";
import { controllerMatrix, viewMatrix } from "../render/core/controllerInput.js";
import { linefont } from "../render/core/linefont.js";
import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";

const ROUND_TIME  = 120;         // 2 minute rounds
const N_FACES     = 3;
const FACE_SIZE   = .26;         // meters, face is a square of this size
const HIT_DIST    = .22;         // glove-to-face-center distance for a punch
const SHATTER     = .7;          // seconds of shatter animation
const N_SHARD     = 16;          // 4x4 mirror shards per face
const GLOVE_SCALE = .12;         // glb is 1.9 units long

// ---------- linefont text helpers (scene-local copies of what the
// ---------- linefont scenes use, so no engine changes are needed) -------

let pathsMesh = (name, width, paths) => {
   let add = cg.add, sub = cg.subtract, vertices = [];
   let addVertex = pos => vertices.push(clay.vertexArray(pos, [0,0,1]));
   for (let n = 0 ; n < paths.length ; n++) {
      let path = paths[n];
      for (let i = 0 ; i < path.length-1 ; i++) {
         let b = path[i  ];
         let c = path[i+1];
         let a = i > 0 ? path[i-1] : add(b,sub(b,c));
         let da = cg.normalize(sub(b,a));
         let dc = cg.normalize(sub(c,b));
         let db = cg.normalize(add(da,dc));
         let s = cg.dot(da, db);
         da = cg.scale(da,width/2);
         dc = cg.scale(dc,width/2);
         db = cg.scale(db,width/2);
         let ea = [da[1]  ,-da[0]  ,0];
         let ec = [dc[1]  ,-dc[0]  ,0];
         let eb = [db[1]/s,-db[0]/s,0];
         if (i == 0)
            b = sub(b,da);
         if (cg.dot(da,dc) < 0) {
            addVertex(sub(b,ea));
            addVertex(add(b,ea));
            addVertex(sub(b,ec));
            addVertex(add(b,ec));
         }
         else {
            addVertex(sub(b,eb));
            addVertex(add(b,eb));
         }
         if (i == path.length-2) {
            addVertex(sub(add(c,dc),ec));
            addVertex(add(add(c,dc),ec));
         }
      }
   }
   clay.defineMesh(name, new Float32Array(vertices.flat()));
}

let textNames = {}, textIx = 0;
let textMesh = text => {                         // CACHE A MESH PER TEXT STRING
   let name = textNames[text];
   if (! name) {
      name = 'bt' + textIx++;
      textNames[text] = name;
      let myPaths = [], lines = text.split('\n'), ch;
      for (let row = 0 ; row < lines.length ; row++)
      for (let col = 0 ; col < lines[row].length ; col++)
         if ((ch = lines[row].charCodeAt(col) & 127) > 32) {
            let x = .019*col, y = .0375*row;
            let paths = linefont[ch - 32].paths;
            for (let i = 0 ; i < paths.length ; i++) {
               let myPath = [], path = paths[i];
               for (let j = 0 ; j < path.length ; j++)
                  myPath.push([ x + path[j][0] / 4000,
                               -y - path[j][1] / 4000, 0]);
               myPaths.push(myPath);
            }
         }
      pathsMesh(name, .0035, myPaths);
   }
   return name;
}

// A TEXT NODE WHOSE STRING CAN BE SWAPPED (OLD NODE IS REMOVED).

let textBox = (parent, rgb) => {
   let node = null, cur = null;
   return {
      set: text => {
         if (text === cur)
            return node;
         if (node)
            parent.remove(node);
         cur = text;
         node = text === null ? null : parent.add(textMesh(text)).color(...rgb);
         return node;
      },
      node: () => node,
   };
}

// ---------- game state ----------

let phase = 'idle';            // idle | countdown | playing | over
let phaseEnd = 0, goUntil = 0, score = 0;
let faces = [], popups = [], popupIx = 0;
let hudTime, hudScore, bigMsg, subMsg;
let shownBig = null;

let headM = () => {            // HEAD MATRIX IN WORLD SPACE
   if (viewMatrix && viewMatrix.length)
      return cg.mMultiply(clay.inverseRootMatrix, cg.mInverse(viewMatrix[0]));
   return cg.mMultiply(clay.inverseRootMatrix, cg.mTranslate(0,1.6,1.4));
}
let headFwd = m => { let f = [-m[8],-m[9],-m[10]];
                     return cg.normalize([f[0],0,f[2]]); }
let yawTo = (from, to) => Math.atan2(to[0]-from[0], to[2]-from[2]);

let randomFacePos = at => {    // REACHABLE SPOT SOMEWHERE IN FRONT OF THE HEAD
   let fwd = headFwd(headM());
   let right = [fwd[2], 0, -fwd[0]];
   let r = () => Math.random() - .5;
   return cg.add(cg.add(cg.add(at, cg.scale(fwd, .55 + .35*Math.random())),
                        cg.scale(right, .9 * r())),
		 [0, .35 * r() + .1, 0]);
}

export const init = async model => {

   // GOLDEN GLOVES, ATTACHED TO THE CONTROLLERS EACH FRAME (left glove glb,
   // true mirrored glb for the right hand so we avoid negative scaling).

   let gloves = {
      left : new Gltf2Node({ url: './media/gltf/glove/glove.glb' }),
      right: new Gltf2Node({ url: './media/gltf/glove/glove_right.glb' }),
   };
   global.gltfRoot.addNode(gloves.left);
   global.gltfRoot.addNode(gloves.right);

   // FACES + THEIR PRE-CREATED MIRROR SHARDS + +20 POPUPS.

   let facesG = model.add(), fxG = model.add();
   for (let i = 0 ; i < N_FACES ; i++) {
      let face = {
	 node: facesG.add('square').setTxtr('media/textures/face.jpeg'),
	 pos: randomFacePos([0,1.6,0]), state: 'alive', t0: 0, shards: [],
      };
      for (let j = 0 ; j < N_SHARD ; j++)
	 face.shards.push({
	    node: facesG.add('square').setTxtr('media/textures/face.jpeg'),
	    ox: ((j % 4) - 1.5) / 4 * FACE_SIZE,
	    oy: ((j / 4 >> 0) - 1.5) / 4 * FACE_SIZE,
	    vx: 0, vy: 0, vz: 0, rx: 0, ry: 0,
	 });
      faces.push(face);
   }
   for (let i = 0 ; i < 3 ; i++)
      popups.push(textBox(fxG, [1,.85,.2]).set('+20').scale(0));

   let startRound = at => {
      score = 0;
      spawnFaces(at);
      phase = 'countdown';
      phaseEnd = model.time + 3;
   }

   let spawnFaces = at => {
      for (let f of faces) {
	 f.pos = randomFacePos(at);
	 f.state = 'alive';
      }
   }

   // RIGHT TRIGGER STARTS / RESTARTS THE ROUND. REASSIGN EVERY HANDLER SO
   // STALE ONES FROM A PREVIOUS SCENE CAN'T FIRE.

   inputEvents.onMove = hand => { };
   inputEvents.onClick = hand => { };
   inputEvents.onPress = hand => {
      if (hand == 'right' && (phase == 'idle' || phase == 'over'))
         startRound(headM().slice(12,15));
   }
   inputEvents.onDrag = (hand, elapsed) => { };
   inputEvents.onRelease = (hand, elapsed) => { };
   inputEvents.onDoublePress = hand => { };

   model.animate(() => {
      let t = model.time;

      // ----- GLOVE PLACEMENT -----

      let tips = { left: null, right: null };
      for (let hand in gloves) {
	 let m = cg.mMultiply(clay.inverseRootMatrix, controllerMatrix[hand]);
	 let local = cg.mMultiply(cg.mTranslate(0,-.02,-.07),
		      cg.mMultiply(cg.mRotateX(-Math.PI/2),
				   cg.mScale(GLOVE_SCALE, GLOVE_SCALE, GLOVE_SCALE)));
	 gloves[hand].matrix = cg.mMultiply(m, local);
	 tips[hand] = cg.mTransform(m, [0,0,-.12]);
      }

      // ----- PHASE TRANSITIONS -----

      let hM = headM(), headAt = hM.slice(12,15);
      if (phase == 'countdown' && t >= phaseEnd) {
         phase = 'playing';
         phaseEnd = t + ROUND_TIME;
         goUntil = t + 1;
      }
      if (phase == 'playing' && t >= phaseEnd)
         phase = 'over';

      // ----- FACES: BILLBOARD, PUNCH TEST, SHATTER ANIMATION -----

      for (let f of faces) {
         if (f.state == 'alive') {
            f.node.identity().move(f.pos).turnY(yawTo(f.pos, headAt))
                           .scale(FACE_SIZE/2);
            if (phase == 'playing')
               for (let hand in tips)
                  if (tips[hand] && cg.distance(tips[hand], f.pos) < HIT_DIST) {
                     f.state = 'shatter';
                     f.t0 = t;
                     score += 20;
                     for (let s of f.shards) {
                        let d = Math.hypot(s.ox, s.oy) || .01;
                        let blow = 1.6 + Math.random();
                        s.vx = (s.ox/d) * blow + (Math.random()-.5);
                        s.vy = (s.oy/d) * blow + .4 + Math.random()*.6;
                        s.vz = (Math.random()-.5) * 1.2 + .8;
                        s.rx = (Math.random()-.5) * 12;
                        s.ry = (Math.random()-.5) * 12;
                     }
                     let p = popups[popupIx++ % popups.length];
                     p.popupAt = f.pos.slice();
                     p.popupT0 = t;
                     if (window.vibrate) {
                        vibrate('left' , 1, 30);
                        vibrate('right', 1, 30);
                     }
                     break;
                  }
         }
         else if (f.state == 'shatter') {
            let dt = t - f.t0, yaw = yawTo(f.pos, headAt), k = 1 - dt/SHATTER;
            if (k <= 0) {
               f.state = 'dead';
            }
            else {
               f.node.identity().scale(0);        // FACE IS GONE
               for (let s of f.shards) {
                  let grav = 1.8 * dt * dt;
                  s.node.identity()
                        .move(f.pos[0] + s.vx*dt,
			      f.pos[1] + s.vy*dt - grav,
			      f.pos[2] + s.vz*dt)
                        .turnY(yaw + s.ry*dt)
                        .turnX(s.rx*dt)
                        .scale(FACE_SIZE/2 * k);
               }
            }
         }
         else if (f.state == 'dead' && phase == 'playing') {
            f.pos = randomFacePos(headAt);
            f.state = 'alive';
         }
      }

      // HIDE SHARDS OF FACES THAT AREN'T SHATTERING.

      for (let f of faces)
         if (f.state != 'shatter')
            for (let s of f.shards)
               s.node.identity().scale(0);

      // ----- +20 POPUPS: RISE AND FADE OUT -----

      for (let p of popups) {
         if (p.popupAt === undefined)
            continue;
         let dt = t - p.popupT0;
         if (dt > .8) {
            p.scale(0);
            p.popupAt = undefined;
         }
         else
            p.identity().move(p.popupAt[0], p.popupAt[1] + .5*dt, p.popupAt[2])
                        .turnY(yawTo(p.popupAt, headAt))
                        .scale(3 + dt*2)
                        .opacity(1 - dt/.8);
      }

      // ----- HEAD-ANCHORED HUD: TIME LEFT AND SCORE, SIDE BY SIDE -----

      let fwd = headFwd(hM);
      let hudAt = cg.add(cg.add(headAt, cg.scale(fwd, 1.2)), [0,.55,0]);
      let hudYaw = yawTo(hudAt, headAt);
      let timeStr = null;
      if (phase == 'playing') {
         let secs = Math.max(0, Math.ceil(phaseEnd - t));
         timeStr = (secs / 60 >> 0) + ':' + ('0' + (secs % 60)).slice(-2);
      }
      else if (phase == 'over')
         timeStr = '0:00';
      if (! hudTime)
         hudTime = textBox(facesG, [.4,.8,1]);
      hudTime.set(timeStr === null ? null : 'TIME ' + timeStr);
      if (hudTime.node())
         hudTime.node().identity()
               .move(hudAt[0]-.34*fwd[2], hudAt[1], hudAt[2]+.34*fwd[0])
               .turnY(hudYaw).scale(2.2);
      if (! hudScore) {
         hudScore = textBox(facesG, [1,.85,.2]);
         hudScore.set('SCORE 0');
      }
      hudScore.set('SCORE ' + score);
      hudScore.node().identity()
              .move(hudAt[0]+.34*fwd[2], hudAt[1], hudAt[2]-.34*fwd[0])
              .turnY(hudYaw).scale(2.2);

      // ----- CENTER MESSAGES: INSTRUCTIONS, COUNTDOWN, ROUND OVER -----

      let centerAt = cg.add(cg.add(headAt, cg.scale(fwd, .7)), [0,.1,0]);
      let big = null, sub = null;
      if (phase == 'idle') {
         big = 'PULL RIGHT TRIGGER';
         sub = 'TO BOX FOR 2 MINUTES';
      }
      else if (phase == 'countdown')
         big = '' + Math.ceil(phaseEnd - t);
      else if (t < goUntil)
         big = 'GO !';
      else if (phase == 'over') {
         big = 'TIME !';
         sub = 'FINAL SCORE ' + score;
      }
      if (big !== shownBig) {
         shownBig = big;
         if (bigMsg) bigMsg.set(null);
         if (big    === null) bigMsg = null;
         else { bigMsg = textBox(facesG, [1,.3,.25]); bigMsg.set(big); }
         if (subMsg) subMsg.set(null);
         if (sub === null) subMsg = null;
         else { subMsg = textBox(facesG, [1,1,1]); subMsg.set(sub); }
      }
      if (bigMsg)
         bigMsg.node().identity().move(centerAt)
               .turnY(yawTo(centerAt, headAt)).scale(6);
      if (subMsg)
         subMsg.node().identity()
               .move(centerAt[0], centerAt[1]-.28, centerAt[2])
               .turnY(yawTo(centerAt, headAt)).scale(2.5);
   });
}
