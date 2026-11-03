import * as cg from "../render/core/cg.js";
import { buildPenguin, PENGUIN_HEIGHT, PENGUIN_EYE_H } from "./pooltable/penguin.js";
import { buildBalls } from "./pooltable/balls.js";
import { controllerMatrix, joyStickState } from "../render/core/controllerInput.js";

// MINIATURE POOL TABLE: 15 RACKED BALLS + CUE ON A GREEN FELT, PLUS A
// PENGUIN AVATAR REBUILT FROM THE CHARACTER-STUDIO PENGUIN. 1 IN = 1 FT:
// THE PENGUIN STANDS EXACTLY 152 mm (6 IN) TALL ON THE FELT.
//
// THE PENGUIN IS AN INDEPENDENT CHARACTER - IT NEVER MIRRORS YOUR HEAD
// OR HANDS (NO CONTROLLER MAPPING, UNLIKE THE EARLIER MINI-ME SCENES).
// MODE 1 (3RD PERSON): YOUR REAL HEAD WATCHES THE PENGUIN; TRIGGER GRABS BALLS.
// MODE 2 (PENGUIN POV): THE CAMERA RIDES THE PENGUIN; TRIGGER DOES NOTHING.
// THE JOYSTICK MOVES THE PENGUIN IN BOTH MODES; WALKING BODY-CHECKS BALLS,
// AND BALLS THAT ROLL INTO POCKETS SINK AND RESPAWN AT THE RACK.
//
// VIEWPOINT: EVERYTHING MINIATURE LIVES UNDER ONE NODE (miniRoot) IN
// MINIATURE SPACE (FELT TOP = y 0). ONE MATRIX PER FRAME MAPS IT TO THE WORLD:
//    MODE 1:  G1 = T(anchor)                      DIORAMA ON THE REAL TABLE
//    MODE 2:  G2 = H . S(12) . INVERSE(A)         YOUR EYE ON THE PENGUIN'S EYE,
//                                                 WORLD INFLATED 12x ABOUT IT,
//                                                 VIEW ROTATED BY YOUR HEAD
// (A = PENGUIN HEAD MARKER: T([px,eyeH,pz]) . RY(yaw).) THE TRANSITION
// BLENDS TRANSLATION, QUATERNION-SLERPED ROTATION AND SCALE 12^ease(t).
//
// NO INSTRUCTION BOARDS ANYWHERE. KEYS: 'v' TOGGLE, 't'/'r' PLACE, 'd' DEBUG
// (CONSOLE + TRANSLUCENT GRAB VOLUME ONLY).

const SCALE     = 12;                            // 1 IN = 1 FT
const TABLE_H   = .762;                          // REAL TABLE HEIGHT: ~30 IN
const FELT_W    = 1.30, FELT_D = .62;            // FELT PLAYFIELD, MINIATURE METERS
const ROOM_W    = 7.3, ROOM_D = 7.3, ROOM_H = 2.7;   // CLASSROOM REPLICA, 1/12 SCALE
const TRANSIT   = .8;                            // SECONDS TO SWITCH VIEWS
const GRAB_R    = .16;                           // GRAB REACH, WORLD METERS
const PENGUIN_SPEED = .45;                       // MINIATURE METERS PER SECOND
const PENGUIN_R = .07;                           // BODY RADIUS FOR BALL PUSHES

let anchor = [0, TABLE_H, -.5];                  // MINIATURE-SPACE ORIGIN ON THE REAL TABLETOP
let mode = 1;                                    // 1 = 3RD PERSON, 2 = PENGUIN POV
let placed = false, debug = false;
let transition = 1;                              // 0..1, PROGRESS OF A MODE SWITCH
let gM = null;                                   // CURRENT G MATRIX (MINIATURE -> WORLD)
let grabbed = null;                              // { hand, ball, offset, lastPos, lastT }
let suppress = false;
let pengSpeed = 0;
let pocketedCount = 0, nextDbg = 0;

const Q_IDENT = [0, 0, 0, 1];

let qSlerp = (a, b, t) => {                      // QUATERNION SLERP (CG LACKS ONE)
   let d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
   let q = b.slice();
   if (d < 0) { q = [-b[0],-b[1],-b[2],-b[3]]; d = -d; }
   let theta = Math.acos(Math.min(1, d));
   let s = theta < 1e-4 ? 1 - t : Math.sin((1 - t) * theta) / Math.sin(theta);
   let u = theta < 1e-4 ? t       : Math.sin(t * theta)       / Math.sin(theta);
   return [a[0]*s + q[0]*u, a[1]*s + q[1]*u, a[2]*s + q[2]*u, a[3]*s + q[3]*u];
}

let decompose = m => {                           // UNIFORM-SCALE MATRIX -> {p, q, s}
   let s = Math.hypot(m[0], m[1], m[2]);
   let r = [m[0]/s, m[1]/s, m[2]/s, 0,
            m[4]/s, m[5]/s, m[6]/s, 0,
            m[8]/s, m[9]/s, m[10]/s, 0,  0, 0, 0, 1];
   let q = cg.mToQuaternion(r);
   return { p: [m[12], m[13], m[14]], q: [q.x, q.y, q.z, q.w], s };
}

let headMatrix = () => {
   try {
      let v0 = clay.root().inverseViewMatrix(0), v1 = clay.root().inverseViewMatrix(1);
      if (!v0 || !v1) return null;
      return cg.mMultiply(clay.inverseRootMatrix, cg.mix(v0, v1, .5));
   } catch (e) { return null; }
}

let placeAnchor = p => {
   if (!p) return;
   anchor = [p[0], cg.clamp(p[1], .5, 1), p[2]];
   placed = true;
}

let frontOfHead = () => {
   let H = headMatrix();
   if (!H) return [0, TABLE_H, -.5];
   let f = cg.normalize([-H[8], 0, -H[10]]), hp = [H[12], H[13], H[14]];
   return [hp[0] + .45 * f[0], TABLE_H, hp[2] + .45 * f[2]];
}

let toggleMode = () => {
   if (!placed || transition < 1) return;
   if (grabbed) { grabbed.ball.held = false; grabbed = null; }
   suppress = true;
   mode = 3 - mode;
   transition = 0;
}

let clampFelt = p => [
   cg.clamp(p[0], -FELT_W/2 + .07, FELT_W/2 - .07), 0,
   cg.clamp(p[2], -FELT_D/2 + .07, FELT_D/2 - .07)];

export const init = async model => {

   let miniRoot = model.add();

   // THE POOL TABLE: FELT GROUND, WOOD APRON + RAILS, SIX POCKETS

   let felt = miniRoot.add('cube').color([.13,.42,.2]);
   felt.identity().move([0, -.015, 0]).scale(FELT_W/2, .015, FELT_D/2);
   let apron = miniRoot.add('cube').color([.28,.18,.1]);
   apron.identity().move([0, -.048, 0]).scale(.70, .05, .33);
   let wood = [.45,.3,.16];
   let railL1 = miniRoot.add('cube').color(wood);
   railL1.identity().move([0, .012, -(FELT_D/2 + .0225)]).scale(FELT_W/2 + .05, .025, .045);
   let railL2 = miniRoot.add('cube').color(wood);
   railL2.identity().move([0, .012,  (FELT_D/2 + .0225)]).scale(FELT_W/2 + .05, .025, .045);
   let railS1 = miniRoot.add('cube').color(wood);
   railS1.identity().move([-(FELT_W/2 + .0225), .012, 0]).scale(.045, .025, FELT_D/2);
   let railS2 = miniRoot.add('cube').color(wood);
   railS2.identity().move([ (FELT_W/2 + .0225), .012, 0]).scale(.045, .025, FELT_D/2);
   for (let sx = -1 ; sx <= 1 ; sx += 2)
      for (let sz = -1 ; sz <= 1 ; sz += 2) {
         let p = miniRoot.add('tubeY').color([.05,.05,.06]);
         p.identity().move([sx * (FELT_W/2 - .06), .001, sz * (FELT_D/2 - .06)]).scale(.034, .006, .034);
      }
   for (let sz = -1 ; sz <= 1 ; sz += 2) {
      let p = miniRoot.add('tubeY').color([.05,.05,.06]);
      p.identity().move([0, .001, sz * (FELT_D/2 - .01)]).scale(.034, .006, .034);
   }

   let boundsBox = miniRoot.add('cube').color('cyan');   // DEBUG ONLY
   boundsBox.identity().scale(FELT_W/2, .12, FELT_D/2).move([0, .12, 0]).opacity(0);

   let axes = miniRoot.add();                            // DEBUG ONLY
   axes.add('cube').color('red'  ).identity().move([ .05,0,0]).scale(.05,.0015,.0015);
   axes.add('cube').color('green').identity().move([0,.05,0]).scale(.0015,.05,.0015);
   axes.add('cube').color('blue' ).identity().move([0,0, .05]).scale(.0015,.0015,.05);
   axes.opacity(0);

   // 1/12 CLASSROOM REPLICA, IDENTICAL TO THE MINIATURE SCENE - MODE 2 ONLY

   let room = miniRoot.add();
   let wall = (x, y, z, sx, sy, sz, dx, dz) => {
      for (let s = -1 ; s <= 1 ; s += 2) {        // TWO SHELLS SO IT READS FROM INSIDE
         let w = room.add('cube').color([.85,.8,.72]);
         w.identity().move([x + s * dx, y, z + s * dz]).scale(sx, sy, sz);
      }
   };
   let ry = -.005 + ROOM_H/2;
   wall(0, ry, -ROOM_D/2, ROOM_W, ROOM_H, .003, 0, .003);
   wall(0, ry,  ROOM_D/2, ROOM_W, ROOM_H, .003, 0, .003);
   wall(-ROOM_W/2, ry, 0, .003, ROOM_H, ROOM_D, .003, 0);
   wall( ROOM_W/2, ry, 0, .003, ROOM_H, ROOM_D, .003, 0);
   let roomFloor = room.add('cube').color([.3,.2,.12]);
   roomFloor.identity().move([0, -.0051, 0]).scale(ROOM_W/2, .0009, ROOM_D/2);
   room.opacity(0);

   // THE BALLS AND THE PENGUIN

   let ballsMod = buildBalls(miniRoot, { w: FELT_W, d: FELT_D, pocketR: .034 });
   let peng = buildPenguin(miniRoot);

   console.log('pooltable: penguin height ' + (1000 * PENGUIN_HEIGHT) + ' mm (6 in at 1/12 scale)');

   // INPUT

   inputEvents.onPress = hand => {
      if (suppress) return;
      let p = inputEvents.pos(hand);
      if (!placed) { placeAnchor(p); return; }
      if (transition < 1 || !p) return;
      if (mode != 1) return;                       // NO CONTROLLER ACTIONS IN PENGUIN POV

      for (let b of ballsMod.balls) {              // GRAB THE NEAREST BALL IN REACH
         let bw = cg.mTransform(gM, b.pos);
         if (b.active && cg.distance(p, bw) < GRAB_R) {
            let m = cg.mInverse(gM);
            grabbed = { hand, ball: b,
                        offset: cg.subtract(b.pos, cg.mTransform(m, p)),
                        lastPos: p, lastT: model.time };
            b.held = true;
            return;
         }
      }
   }
   inputEvents.onDrag = hand => {
      if (!grabbed || grabbed.hand != hand) return;
      let p = inputEvents.pos(hand);
      if (!p) return;
      grabbed.ball.pos = cg.add(cg.mTransform(cg.mInverse(gM), p), grabbed.offset);
      grabbed.ball.pos[1] = ballsMod.R + .04;      // CARRIED ABOVE THE FELT
      grabbed.lastPos = p;
      grabbed.lastT = model.time;
   }
   inputEvents.onRelease = hand => {
      if (grabbed && grabbed.hand == hand) {
         let b = grabbed.ball;
         b.held = false;
         b.pos[1] = ballsMod.R;
         let v = cg.scale(cg.subtract(inputEvents.pos(hand) || grabbed.lastPos, grabbed.lastPos),
                          1 / Math.max(.016, model.time - grabbed.lastT));
         let vm = cg.mTransform(cg.mInverse(gM), v);
         vm = cg.subtract(vm, cg.mTransform(cg.mInverse(gM), [0,0,0]));
         let sp = cg.norm([vm[0], vm[2]]);
         if (sp > .5) vm = cg.scale(vm, .5 / sp);  // CAP THROWS AT .5 M/S IN MINIATURE SPACE
         b.vel = [vm[0], 0, vm[2]];
         grabbed = null;
      }
      suppress = false;
   }
   inputEvents.onDoublePress = hand => toggleMode();

   if (!window.pooltableKeys) {
      window.pooltableKeys = true;
      document.addEventListener('keydown', e => {
         let k = (e.key || '').toLowerCase();
         if (k == 'v') toggleMode();
         if (k == 't') placeAnchor(frontOfHead());
         if (k == 'r' && mode == 1) placed = false;
         if (k == 'd') debug = !debug;
      });
   }

   // ANIMATION LOOP

   model.animate(() => {
      let t = model.time, dt = Math.min(model.deltaTime, .1);
      let H = headMatrix();

      // JOYSTICK LOCOMOTION - BOTH MODES. FORWARD = YOUR HEAD'S FORWARD.
      // THE PENGUIN IS INDEPENDENT: THE CAMERA NEVER DRIVES ITS POSE.

      let j = joyStickState.right, jl = joyStickState.left;
      let sx = (Math.abs(j.x) > .15 ? j.x : 0) + (Math.abs(jl.x) > .15 ? jl.x : 0);
      let sy = (Math.abs(j.y) > .15 ? j.y : 0) + (Math.abs(jl.y) > .15 ? jl.y : 0);
      let mag = Math.min(1, Math.hypot(sx, sy));
      pengSpeed = 0;
      if (mag > 0 && H) {
         let f = cg.normalize([-H[8], 0, -H[10]]), r = [-f[2], 0, f[0]];
         let dir = cg.normalize(cg.add(cg.scale(f, -sy), cg.scale(r, sx)));
         peng.pos = clampFelt(cg.add(peng.pos, cg.scale(dir, PENGUIN_SPEED * mag * dt)));
         peng.yaw = cg.mixAngle(peng.yaw, Math.atan2(-dir[0], -dir[2]), Math.min(1, 8 * dt));
         pengSpeed = PENGUIN_SPEED * mag;
      }

      // THE ONE MATRIX THAT MAPS MINIATURE SPACE TO THE WORLD

      transition = Math.min(1, transition + dt / TRANSIT);
      let e = cg.ease(transition);
      let p1 = anchor, q1 = Q_IDENT;
      let A = cg.mMultiply(cg.mTranslate([peng.pos[0], PENGUIN_EYE_H, peng.pos[2]]),
                           cg.mRotateY(peng.yaw));
      let p2 = p1, q2 = q1;
      if (H) {
         let G2 = cg.mMultiply(H, cg.mMultiply(cg.mScale(SCALE), cg.mInverse(A)));
         let d2 = decompose(G2);
         p2 = d2.p; q2 = d2.q;
      }
      let gPos = cg.mix(p1, p2, e);
      let gQ = qSlerp(q1, q2, e);
      let gScale = Math.pow(SCALE, e);
      gM = cg.mMultiply(cg.mMultiply(cg.mTranslate(gPos),
                    cg.mFromQuaternion({x: gQ[0], y: gQ[1], z: gQ[2], w: gQ[3]})),
                    cg.mScale(gScale));
      miniRoot.setMatrix(gM);

      // PHYSICS + DRAW

      let before = ballsMod.balls.filter(b => b.active).length;
      ballsMod.update(dt, { pos: peng.pos, speed: pengSpeed, r: PENGUIN_R });
      pocketedCount += before - ballsMod.balls.filter(b => b.active).length;
      peng.update({ t, dt, moving: pengSpeed > .02, ride: mode == 2 });

      // DEBUG: NO BOARDS - JUST VOLUME BOX + CONSOLE

      if (debug) {
         boundsBox.opacity(.15);
         axes.opacity(1);
         if (t > nextDbg) {
            nextDbg = t + .5;
            console.log('pooltable mode ' + mode + ' | penguin ' + cg.roundVec(2, peng.pos) +
                        ' yaw ' + cg.round(1, peng.yaw) + ' | pocketed ' + pocketedCount +
                        ' | penguin height ' + (1000 * PENGUIN_HEIGHT) + ' mm');
         }
      }
      else {
         boundsBox.opacity(0);
         axes.opacity(0);
      }

      // THE 1/12 CLASSROOM REPLICA IS ONLY WORN IN PENGUIN POV

      room.opacity(mode == 2 ? 1 : 0);
   });
}
