import * as cg from "../render/core/cg.js";
import { buildPenguin, PENGUIN_HEIGHT, PENGUIN_EYE_H } from "./pooltable/penguin.js";
import { buildBalls } from "./pooltable/balls.js";
import { controllerMatrix, joyStickState, buttonState } from "../render/core/controllerInput.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";
import * as global from "../global.js";

// MINIATURE POOL TABLE: 15 RACKED BALLS + CUE ON A GREEN FELT, PLUS A
// PENGUIN AVATAR - THE EXACT CHARACTER-STUDIO PENGUIN EXPORTED TO GLB
// (MEDIA/GLTF/PENGUIN; A CLAY REBUILT FALLBACK IF THE FILE IS MISSING).
// 1 IN = 1 FT: THE PENGUIN STANDS EXACTLY 152 mm (6 IN) TALL ON THE FELT.
//
// THE PENGUIN IS AN INDEPENDENT CHARACTER - IT NEVER MIRRORS YOUR HEAD
// OR HANDS (NO CONTROLLER MAPPING, UNLIKE THE EARLIER MINI-ME SCENES).
// MODE 1 (3RD PERSON): YOUR REAL HEAD WATCHES THE PENGUIN; TRIGGER GRABS BALLS.
// MODE 2 (PENGUIN POV): THE CAMERA RIDES THE PENGUIN; TRIGGER DOES NOTHING.
// THE JOYSTICK MOVES THE PENGUIN IN BOTH MODES; WALKING BODY-CHECKS BALLS,
// AND BALLS THAT ROLL INTO POCKETS SINK AND RESPAWN AT THE RACK. BALLS
// MOVE ONLY IN THE FELT PLANE - NOTHING LIFTS THEM OFF THE TABLE.
//
// THE CUE STICK: THE PENGUIN HOLDS IT HORIZONTALLY; IT AIMS WITH YOUR
// HEAD YAW IN BOTH MODES, FIXED AT BALL-CENTER HEIGHT. IN 3RD PERSON YOU
// SEE THE AIM RAY, IN PENGUIN POV AN AIMPOINT. LONG-PRESS A (RIGHT
// CONTROLLER) TO LOAD - THE CUE PULLS BACK AND DARKENS - RELEASE TO
// STRIKE THE BALL ON THE AIM LINE.
//
// VIEWPOINT: EVERYTHING MINIATURE LIVES UNDER ONE NODE (miniRoot) IN
// MINIATURE SPACE (FELT TOP = y 0). ONE MATRIX PER FRAME MAPS IT TO THE WORLD:
//    MODE 1:  G1 = T(anchor)            STATIONARY DIORAMA ON THE REAL TABLE
//    MODE 2:  G2 = T(CAM) . RY(yaw) . S(12) . INVERSE(A)
//    THE CAMERA IS PINNED TO CAM = [0, 12*EYE_H, 0] AND THE TRANSFORM IS
//    BUILT ONLY FROM THE PENGUIN'S POSE, YAW ONLY - THE CAMERA NEVER
//    MOVES UP OR DOWN, YOUR HEAD YAW TURNS THE PENGUIN, AND THE ROOM
//    NEVER DRAGS WITH YOUR HEAD. (A = PENGUIN HEAD MARKER.)
// THE TRANSITION BLENDS TRANSLATION, QUATERNION-SLERPED ROTATION AND
// SCALE 12^ease(t) TOWARD WHICHEVER MODE IS CURRENT.
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
const CUE_Y     = .105;                          // CUE HEIGHT: UPPER-BODY OF THE PENGUIN
const CUE_TIP   = .15;                           // CUE TIP DISTANCE FROM BODY CENTER
const AIM_MAX   = .9;                            // AIM RAY REACH, MINIATURE METERS
const CHARGE_T  = 1.2;                           // SECONDS TO FULL CHARGE (HOLD A)
const STRIKE_LO = 1.2, STRIKE_HI = 4.0;          // SHOT SPEED RANGE, MINIATURE M/S

let anchor = [0, TABLE_H, -.5];                  // MINIATURE-SPACE ORIGIN ON THE REAL TABLETOP
let mode = 1;                                    // 1 = 3RD PERSON, 2 = PENGUIN POV
let placed = false, debug = false;
let transition = 1;                              // 0..1, PROGRESS OF A MODE SWITCH
let gM = null;                                   // CURRENT G MATRIX (MINIATURE -> WORLD)
let grabbed = null;                              // { hand, ball, offset, lastPos, lastT }
let suppress = false;
let pengSpeed = 0;
let pocketedCount = 0, nextDbg = 0;
let glbReady = false;                            // THE GLB PENGUIN REPLACES THE CLAY ONE
let cueAnim = { state: 'idle', t0: 0, charge: 0, applied: false };
let prevA = false, aimYaw = 0, aimL = .5, aimBall = null;

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

   // THE EXACT CHARACTER-STUDIO PENGUIN, EXPORTED TO GLB (MEDIA/GLTF/PENGUIN),
   // LOADED LIKE THE BUDDHA SCENE. IT REPLACES THE CLAY PENGUIN WHEN READY
   // (THE CLAY ONE STAYS AS THE FALLBACK IF THE FILE IS MISSING).
   // THE GLB IS ~1 UNIT TALL, FEET AT y=0, FACING +z - HENCE THE SCALE AND
   // THE EXTRA HALF-TURN TO MATCH THE CLAY -z FORWARD CONVENTION.

   let pengGltf = new Gltf2Node({ url: './media/gltf/penguin/penguin.glb' });
   global.gltfRoot.addNode(pengGltf);
   pengGltf.waitForComplete()
      .then(() => { glbReady = true; console.log('pooltable: glb penguin loaded'); })
      .catch(() => console.log('pooltable: glb penguin failed - keeping the clay penguin'));

   // THE CUE STICK: HORIZONTAL, HELD AT THE PENGUIN'S UPPER BODY. IT AIMS
   // WITH YOUR HEAD IN BOTH MODES. LONG-PRESS A (RIGHT CONTROLLER) TO LOAD
   // - IT PULLS BACK AND DARKENS - RELEASE TO STRIKE THE BALL ON THE AIM RAY.

   let cueRoot = miniRoot.add();
   let cueSlide = cueRoot.add();                   // SLIDES BACK WHEN LOADING, LUNGES ON HIT
   let cueButt = cueSlide.add('tubeZ').color([.55,.32,.16]);
   let cueShaft = cueSlide.add('tubeZ').color([.78,.6,.38]);
   let cueFerrule = cueSlide.add('tubeZ').color([.92,.9,.85]);
   let cueTip = cueSlide.add('sphere').color([.3,.5,.9]);

   // THE AIM VISUALS: A RAY FROM THE CUE TIP AT BALL-CENTER HEIGHT IN 3RD
   // PERSON, AND AN AIMPOINT MARKER IN PENGUIN POV. THE RAY IS FIXED AT
   // BALL-CENTER HEIGHT; ONLY YOUR HEAD YAW SWINGS IT AROUND.

   let aimRoot = miniRoot.add();
   let aimLine = aimRoot.add('tubeZ').color([1,.85,.3]);
   let aimDot = aimRoot.add('sphere').color([1,.35,.3]);

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
      grabbed.ball.pos[1] = ballsMod.R + .015;     // CARRIED JUST ABOVE THE FELT
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

      // LOCOMOTION - BOTH MODES. FORWARD = YOUR HEAD'S FORWARD.
      // IN PENGUIN POV YOUR HEAD YAW TURNS THE PENGUIN (THE PERSON ROTATES
      // WITH YOU); IN 3RD PERSON IT FACES WHERE IT WALKS.

      let j = joyStickState.right, jl = joyStickState.left;
      let sx = (Math.abs(j.x) > .15 ? j.x : 0) + (Math.abs(jl.x) > .15 ? jl.x : 0);
      let sy = (Math.abs(j.y) > .15 ? j.y : 0) + (Math.abs(jl.y) > .15 ? jl.y : 0);
      let mag = Math.min(1, Math.hypot(sx, sy));
      pengSpeed = 0;
      let headF = H ? cg.normalize([-H[8], -H[9], -H[10]]) : null;
      let moveDir = null;
      if (mag > 0) {
         let f = headF ? cg.normalize([-headF[0], 0, -headF[2]]) : [0, 0, -1];
         let r = [-f[2], 0, f[0]];
         moveDir = cg.normalize(cg.add(cg.scale(f, -sy), cg.scale(r, sx)));
         peng.pos = clampFelt(cg.add(peng.pos, cg.scale(moveDir, PENGUIN_SPEED * mag * dt)));
         pengSpeed = PENGUIN_SPEED * mag;
      }
      if (headF) {
         let yawTarget = peng.yaw;
         if (mode == 2)
            yawTarget = Math.atan2(-headF[0], -headF[2]);       // POV: HEAD YAW TURNS THE PENGUIN
         else if (moveDir)
            yawTarget = Math.atan2(-moveDir[0], -moveDir[2]);   // 3RD PERSON: FACE THE WALK
         peng.yaw = cg.mixAngle(peng.yaw, yawTarget, Math.min(1, (mode == 2 ? 12 : 8) * dt));
      }

      // THE ONE MATRIX THAT MAPS MINIATURE SPACE TO THE WORLD.
      // MODE 1 POSE: T(anchor) - COMPLETELY STATIONARY, HEAD-INDEPENDENT.
      // MODE 2 POSE: BUILT ONLY FROM THE PENGUIN'S POSE - CAMERA FIXED AT
      // [0, 12*EYE_H, 0], YAW ONLY (LEVEL: NO UP/DOWN CAMERA MOTION). YOUR
      // HEAD YAW TURNS THE PENGUIN, SO THE ROOM NEVER DRAGS WITH YOUR HEAD.

      transition = Math.min(1, transition + dt / TRANSIT);
      let e = cg.ease(transition);
      let blend = mode == 2 ? e : 1 - e;           // BLEND TOWARD THE CURRENT MODE

      let A = cg.mMultiply(cg.mTranslate([peng.pos[0], PENGUIN_EYE_H, peng.pos[2]]),
                           cg.mRotateY(peng.yaw));
      let G2 = cg.mMultiply(cg.mTranslate([0, PENGUIN_EYE_H * SCALE, 0]),
               cg.mMultiply(cg.mRotateY(peng.yaw),
               cg.mMultiply(cg.mScale(SCALE), cg.mInverse(A))));
      let d2 = decompose(G2);

      let gPos = cg.mix(anchor, d2.p, blend);
      let gQ = qSlerp(Q_IDENT, d2.q, blend);
      let gScale = Math.pow(SCALE, blend);
      gM = cg.mMultiply(cg.mMultiply(cg.mTranslate(gPos),
                    cg.mFromQuaternion({x: gQ[0], y: gQ[1], z: gQ[2], w: gQ[3]})),
                    cg.mScale(gScale));
      miniRoot.setMatrix(gM);

      // GLB PENGUIN RIDES THE SAME TRANSFORM (CLAY PENGUIN HIDES UNDERNEATH)

      peng.visible = !glbReady;
      if (glbReady) {
         pengGltf.matrix = cg.mMultiply(gM,
            cg.mMultiply(cg.mTranslate([peng.pos[0], 0, peng.pos[2]]),
            cg.mMultiply(cg.mRotateY(peng.yaw + Math.PI), cg.mScale(PENGUIN_HEIGHT))));
      }

      // AIM: HORIZONTAL RAY FROM THE PENGUIN AT BALL-CENTER HEIGHT, SWUNG BY
      // YOUR HEAD YAW IN BOTH MODES.

      aimYaw = headF ? Math.atan2(-headF[0], -headF[2]) : peng.yaw;
      let dx = -Math.sin(aimYaw), dz = -Math.cos(aimYaw);
      let ox = peng.pos[0] + dx * CUE_TIP, oz = peng.pos[2] + dz * CUE_TIP;
      let hit = ballsMod.pickBall(ballsMod.balls, ox, oz, dx, dz, AIM_MAX);
      aimBall = hit ? hit.ball : null;
      aimL = hit ? hit.dist : AIM_MAX - CUE_TIP;

      // CUE STICK STATE MACHINE: LONG-PRESS A TO LOAD (PULL BACK + DARKEN),
      // RELEASE TO STRIKE. THE STRIKE RE-PICKS THE BALL AT CONTACT MOMENT.

      let ab = !!(buttonState.right[4] && buttonState.right[4].pressed);
      if (ab && !prevA && placed && transition >= 1 && !grabbed)
         cueAnim = { state: 'charge', t0: t, charge: 0, applied: false };
      if (ab && cueAnim.state == 'charge')
         cueAnim.charge = Math.min(1, (t - cueAnim.t0) / CHARGE_T);
      if (!ab && prevA && cueAnim.state == 'charge')       // RELEASED: STRIKE
         cueAnim = { state: 'strike', t0: t, charge: cueAnim.charge, applied: false };
      let pull = 0, dark = 0;
      if (cueAnim.state == 'charge') {
         pull = -.055 * cueAnim.charge;
         dark = cueAnim.charge;
      }
      else if (cueAnim.state == 'strike') {
         let k = Math.min(1, (t - cueAnim.t0) / .16);      // THE LUNGE, 160 ms
         pull = -.055 * cueAnim.charge + (.055 * cueAnim.charge + .025) * Math.min(1, k / .45);
         dark = cueAnim.charge * (1 - Math.min(1, k / .5));
         if (k >= .45 && !cueAnim.applied) {               // CONTACT: LAUNCH THE BALL
            let ch = ballsMod.pickBall(ballsMod.balls,
                                       peng.pos[0] + dx * CUE_TIP, peng.pos[2] + dz * CUE_TIP,
                                       dx, dz, AIM_MAX);
            if (ch) {
               let sp = STRIKE_LO + (STRIKE_HI - STRIKE_LO) * cueAnim.charge;
               ch.ball.vel = [dx * sp, 0, dz * sp];
            }
            cueAnim.applied = true;
         }
         if (k >= 1) cueAnim.state = 'idle';
      }
      prevA = ab;

      // WHILE LOADING, THE PENGUIN TURNS TO FACE THE AIM

      if (cueAnim.state != 'idle' && headF)
         peng.yaw = cg.mixAngle(peng.yaw, aimYaw, Math.min(1, 10 * dt));

      // RENDER CUE + AIM

      cueRoot.identity().move([peng.pos[0], CUE_Y, peng.pos[2]]).turnY(aimYaw);
      cueSlide.identity().move([0, 0, pull]);
      let dd = 1 - .45 * dark;
      cueButt .identity().move([0, 0,  .035]).scale(.0075, .0075, .105).color(.55*dd, .32*dd, .16*dd);
      cueShaft.identity().move([0, 0, -.055]).scale(.0048, .0048, .115).color(.78*dd, .6*dd, .38*dd);
      cueFerrule.identity().move([0, 0, -.118]).scale(.0052, .0052, .016).color(.92*dd, .9*dd, .85*dd);
      cueTip.identity().move([0, 0, -.13]).scale(.0062).color(.3*dd, .5*dd, .9*dd);

      aimRoot.identity().move([peng.pos[0], ballsMod.R, peng.pos[2]]).turnY(aimYaw);
      aimLine.identity().move([0, 0, -(CUE_TIP + aimL / 2)]).scale(.0013, .0013, aimL / 2)
             .opacity(mode == 1 ? .6 : 0);
      aimDot.identity().move([0, 0, -(CUE_TIP + aimL)]).scale(.01)
            .opacity(mode == 2 ? .9 : .7);

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
