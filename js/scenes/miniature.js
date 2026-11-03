import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { buildMouse } from "./miniature/mouse.js";
import { controllerMatrix } from "../render/core/controllerInput.js";

// MINIATURE WORLD: A MOUSE ON A 1/12-SCALE TABLETOP, PLUS A MINI-ME THAT
// MIRRORS YOUR HEAD AND HANDS. 1 INCH = 1 FOOT, SO A 6FT USER'S AVATAR HEAD
// TOPS OUT ABOUT 6 INCHES ABOVE THE SLAB.
//
// CONTROLS
//    TRIGGER PRESS        PLACE THE MINIATURE WORLD ON THE REAL TABLE (ONCE)
//    HOLD TRIGGER + DRAG  MODE 1: GRAB AND MOVE THE MOUSE
//    DOUBLE-PRESS / 'v'   TOGGLE BETWEEN YOUR POV (MODE 1) AND THE MINI-ME'S (MODE 2)
//    TRIGGER PRESS        MODE 2: DROP CHEESE WHERE YOUR HAND IS
//    't' 'r' 'd'          PLACE IN FRONT OF HEAD / RE-PLACE / DEBUG OVERLAY
//
// HOW IT WORKS: EVERYTHING MINIATURE LIVES UNDER ONE NODE (miniRoot) IN
// "MINIATURE SPACE", WHERE THE SLAB TOP IS y = 0 AND THE ANCHOR POINT IS THE
// ORIGIN. ONE MATRIX PER FRAME MAPS MINIATURE SPACE TO THE WORLD:
//    MODE 1:  G = T(anchor)            THE DIORAMA SITS ON THE REAL TABLE
//    MODE 2:  G = T(floorPt) . S(12)   YOU BECOME THE MINI-ME: THE SLAB
//                                      BECOMES A GIANT FLOOR AT YOUR FEET
// (floorPt IS THE POINT ON THE REAL FLOOR BELOW THE ANCHOR.) YOUR POSE IS
// MIRRORED INTO MINIATURE SPACE BY SCALING 1/12 ABOUT floorPt, SO WALKING
// IN THE REAL ROOM WALKS THE MINI-ME AROUND THE SLAB, AND IN MODE 2 THE
// WORLD INFLATES 12x ABOUT THE AVATAR'S HEAD SO YOU SEE THROUGH ITS EYES.

const SCALE   = 12;                        // 1 IN = 1 FT
const SLAB_W  = 1.524, SLAB_D = .610;      // CLASSROOM TABLETOP: 60 x 24 IN
const SLAB_T  = .004;                      // SLAB THICKNESS, MINIATURE METERS
const TABLE_H = .762;                      // REAL TABLE HEIGHT: ~30 IN
const ROOM_W  = 7.3, ROOM_D = 7.3, ROOM_H = 2.7;   // CLASSROOM REPLICA, 1/12 SCALE
const TRANSIT = .8;                        // SECONDS TO SWITCH BETWEEN VIEWS
const GRAB_R  = .16;                       // GRAB REACH, WORLD METERS
const CHEESE_T = 4;                        // SECONDS FOR THE MOUSE TO EAT A CHEESE

let anchor = [0, TABLE_H, -.5];            // MINIATURE-SPACE ORIGIN ON THE REAL TABLETOP
let mode = 1;                              // 1 = MY POV, 2 = MINI-ME POV
let placed = false, debug = false;
let transition = 1;                        // 0..1, PROGRESS OF A MODE SWITCH
let gPos = anchor.slice(), gScale = 1;     // CURRENT G = T(gPos) . S(gScale)
let grabbed = null, grabOffset = null, suppress = false;
let cheese = null;                         // { pos, size }
let crumbs = [], crumbTimer = 0;
let signDirty = true, nextDbg = 0;

// MIRROR A RIGID WORLD MATRIX INTO MINIATURE SPACE: SCALE 1/12 ABOUT floorPt.

let bodyMatrix = m => {
   let q = new Array(16);
   for (let i = 0 ; i < 12 ; i++) q[i] = m[i] / SCALE;
   q[12] = (m[12] - anchor[0]) / SCALE;
   q[13] =  m[13] / SCALE;
   q[14] = (m[14] - anchor[2]) / SCALE;
   q[15] = 1;
   return q;
}

let bodyPoint = p => [(p[0] - anchor[0]) / SCALE, p[1] / SCALE, (p[2] - anchor[2]) / SCALE];

let headMatrix = () => {
   try {
      let v0 = clay.root().inverseViewMatrix(0), v1 = clay.root().inverseViewMatrix(1);
      if (!v0 || !v1) return null;
      return cg.mMultiply(clay.inverseRootMatrix, cg.mix(v0, v1, .5));
   } catch (e) { return null; }
}

let handMatrix = hand => controllerMatrix[hand] && controllerMatrix[hand].length
      ? cg.mMultiply(clay.inverseRootMatrix, controllerMatrix[hand]) : null;

let clampMini = p => [
   cg.clamp(p[0], -SLAB_W/2 + .07, SLAB_W/2 - .07), 0,
   cg.clamp(p[2], -SLAB_D/2 + .07, SLAB_D/2 - .07)];

let placeAnchor = p => {
   if (!p) return;
   anchor = [p[0], cg.clamp(p[1], .5, 1), p[2]];
   placed = true;
   signDirty = true;
}

let frontOfHead = () => {
   let H = headMatrix();
   if (!H) return [0, TABLE_H, -.5];
   let f = cg.normalize([-H[8], 0, -H[10]]), hp = [H[12], H[13], H[14]];
   return [hp[0] + .45 * f[0], TABLE_H, hp[2] + .45 * f[2]];
}

let toggleMode = () => {
   if (!placed || transition < 1) return;
   grabbed = null;                        // ANYTHING HELD IS DROPPED ON A SWITCH
   suppress = true;                       // THE SECOND PRESS OF A DOUBLE-PRESS IS IGNORED
   mode = 3 - mode;
   transition = 0;
   signDirty = true;
}

export const init = async model => {

   // WOOD TEXTURE FOR THE SLAB (STATIC: UPLOADED TO THE GPU ONCE)

   let g2Wood = new G2(true, 512);
   g2Wood.render = function() {
      this.setColor([.62,.45,.26]).fillRect(-1,-1,2,2);
      for (let n = 0 ; n < 5 ; n++) {
         this.setColor(n & 1 ? [.55,.39,.21] : [.67,.5,.3]);
         this.fillRect(-1, -1 + n * .4 + .01, 2, .38);
      }
      this.setColor([.42,.3,.17]).lineWidth(.006);
      for (let n = 0 ; n < 14 ; n++) {
         let y = -1 + .4 * (14 * Math.random() >> 0) + .2;
         let x = -1 + 2 * Math.random();
         this.line([x, y], [x + .3 + Math.random() * .5, y + .04 * (Math.random() - .5)]);
      }
   };
   g2Wood.update();

   // SIGNS (STATIC G2: RE-REGISTER THE SOURCE TO FORCE A RE-UPLOAD)

   let g2Sign = new G2(true, 512);
   let drawSign = () => {
      g2Sign.setColor([0,0,0,.75]).fillRect(-1,-1,2,2);
      g2Sign.setColor('white').textHeight(.13)
            .text(mode == 1 ? 'MINIATURE WORLD: YOUR VIEW' : 'MINIATURE WORLD: MINI-ME VIEW', 0, .68, 'center');
      g2Sign.textHeight(.085);
      if (mode == 1) {
         g2Sign.text('HOLD TRIGGER NEAR MOUSE TO GRAB IT', 0, .3, 'center');
         g2Sign.text('DOUBLE-PRESS TRIGGER (OR KEY V) TO SHRINK', 0, .08, 'center');
      } else {
         g2Sign.text('PRESS TRIGGER TO DROP CHEESE', 0, .3, 'center');
         g2Sign.text('WALK AROUND - YOU ARE 6 INCHES TALL', 0, .08, 'center');
      }
      model.txtrSrc(5, g2Sign.getCanvas());           // RESET THE UPLOAD COUNTER
   }

   let g2Dbg = new G2(true, 512);
   let drawDebug = aPos => {
      g2Dbg.setColor([0,0,.2,.8]).fillRect(-1,-1,2,2);
      g2Dbg.setColor('yellow').textHeight(.09);
      g2Dbg.text('MODE ' + mode + (transition < 1 ? '  (MORPHING)' : ''), 0, .75, 'center');
      g2Dbg.setColor('white').textHeight(.07);
      g2Dbg.text('anchor: ' + cg.roundVec(2, anchor), 0, .45, 'center');
      g2Dbg.text('avatar head above slab: ' + cg.round(100 * aPos[1], 1) + ' cm', 0, .2, 'center');
      g2Dbg.text('(should be your height / 12)', 0, .0, 'center');
      g2Dbg.text('mouse: ' + cg.roundVec(2, mouse.pos), 0, -.25, 'center');
      g2Dbg.text(cheese ? 'cheese: ' + cg.roundVec(2, cheese.pos) : 'no cheese', 0, -.5, 'center');
      model.txtrSrc(6, g2Dbg.getCanvas());
   }

   // THE MINIATURE WORLD

   let miniRoot = model.add();

   let slab = miniRoot.add('cube').txtr(4);           // THE 60in x 24in TABLETOP
   slab.identity().move([0, -SLAB_T/2, 0]).scale(SLAB_W/2, SLAB_T/2, SLAB_D/2);

   let boundsBox = miniRoot.add('cube').color('cyan');  // DEBUG: THE GRAB VOLUME
   boundsBox.identity().scale(SLAB_W/2, .175, SLAB_D/2).move([0, .175, 0]).opacity(0);

   let axes = miniRoot.add();                           // DEBUG: MINIATURE-SPACE AXES
   axes.add('cube').color('red'  ).identity().move([ .05,0,0]).scale(.05,.0015,.0015);
   axes.add('cube').color('green').identity().move([0,.05,0]).scale(.0015,.05,.0015);
   axes.add('cube').color('blue' ).identity().move([0,0, .05]).scale(.0015,.0015,.05);
   axes.opacity(0);

   // 1/12 CLASSROOM REPLICA: FLOOR + 4 WALLS. EACH WALL IS TWO THIN CUBES SO
   // THAT THE ROOM IS VISIBLE FROM INSIDE NO MATTER WHICH FACES GET CULLED.

   let room = miniRoot.add();
   let wall = (x, y, z, sx, sy, sz, dx, dz) => {
      for (let s = -1 ; s <= 1 ; s += 2) {        // TWO SHELLS STRADDLING THE WALL PLANE
         let w = room.add('cube').color([.85,.8,.72]);
         w.identity().move([x + s * dx, y, z + s * dz]).scale(sx, sy, sz);
      }
   };
   let ry = -SLAB_T - .001 + ROOM_H/2;
   wall(0, ry, -ROOM_D/2, ROOM_W, ROOM_H, .003, 0, .003);
   wall(0, ry,  ROOM_D/2, ROOM_W, ROOM_H, .003, 0, .003);
   wall(-ROOM_W/2, ry, 0, .003, ROOM_H, ROOM_D, .003, 0);
   wall( ROOM_W/2, ry, 0, .003, ROOM_H, ROOM_D, .003, 0);
   let roomFloor = room.add('cube').color([.3,.2,.12]);
   roomFloor.identity().move([0, -SLAB_T - .0011, 0]).scale(ROOM_W/2, .0009, ROOM_D/2);
   room.opacity(0);

   // THE MOUSE (THE GRABBABLE MINIATURE OBJECT)

   let mouse = buildMouse(miniRoot, { w: SLAB_W, d: SLAB_D });

   // CHEESE + CRUMBS

   let cheeseNode = miniRoot.add('pyramidZ').color([1,.8,.25]).opacity(0);
   let crumbNodes = [];
   for (let n = 0 ; n < 6 ; n++) {
      crumbNodes.push(miniRoot.add('sphere').color([.95,.78,.3]).opacity(0));
      crumbs.push({ active: false, pos: [0,0,0], vel: [0,0,0], age: 0 });
   }
   let spawnCrumb = pos => {
      for (let c of crumbs) if (!c.active) {
         let a = 2 * Math.PI * Math.random();
         c.active = true; c.age = 0;
         c.pos = pos.slice();
         c.vel = [.05 * Math.cos(a), .08, .05 * Math.sin(a)];
         return;
      }
   };

   // THE MINI-ME: HEAD + TORSO + TWO IK ARMS, MIRRORING MY REAL POSE AT 1/12

   let meHead = miniRoot.add();
   meHead.add('sphere').color([.2,.2,.22]).scale(.11);
   meHead.add('cube').color('white').identity().move( .045,.02,-.105).scale(.012,.025,.01);
   meHead.add('cube').color('white').identity().move(-.045,.02,-.105).scale(.012,.025,.01);
   let meTorso = miniRoot.add('sphere').color([.25,.4,.7]);
   let upL = miniRoot.add('tubeZ').color([.25,.4,.7]);
   let foL = miniRoot.add('tubeZ').color([.25,.4,.7]);
   let upR = miniRoot.add('tubeZ').color([.25,.4,.7]);
   let foR = miniRoot.add('tubeZ').color([.25,.4,.7]);
   let meHandL = miniRoot.add(), meHandR = miniRoot.add();
   meHandL.add('cube').color([.3,.3,.32]).identity().scale(.03,.04,.07);
   meHandR.add('cube').color([.3,.3,.32]).identity().scale(.03,.04,.07);

   let hideArm = (hand, up, fo) => {
      hand.opacity(0); up.opacity(0); fo.opacity(0);
   }
   let link = (node, p1, p2) => {
      let d = cg.subtract(p2, p1);
      node.identity().move(cg.mix(p1, p2, .5)).aimZ(d).scale(.003, .003, cg.norm(d) / 2);
   }
   let arm = (hand, up, fo, shoulder, handWorld, chest, down) => {
      if (!handWorld) { hideArm(hand, up, fo); return; }
      hand.opacity(1); up.opacity(1); fo.opacity(1);
      hand.setMatrix(bodyMatrix(handWorld));
      let wrist = [handWorld[12], handWorld[13], handWorld[14]];
      let d = cg.subtract(wrist, shoulder), n = cg.norm(d);
      let wristC = n > .52 ? cg.add(shoulder, cg.scale(cg.normalize(d), .52)) : wrist;
      let aim = cg.add(cg.normalize(cg.subtract(shoulder, chest)), cg.scale(down, 2));
      let elbow = cg.ik2(shoulder, wristC, .26, .26, aim);
      link(up, bodyPoint(shoulder), bodyPoint(elbow));
      link(fo, bodyPoint(elbow), bodyPoint(wrist));
   }

   // SIGNS: MODE HINT ABOVE THE SLAB, DEBUG PANEL IN WORLD SPACE.
   // EACH IS DOUBLE-SIDED (TWO SQUARES BACK TO BACK) SO IT READS FROM ANY SIDE.

   let sign = miniRoot.add();
   sign.add('square').txtr(5);
   sign.add('square').turnY(Math.PI).txtr(5);

   let debugObj = model.add();
   debugObj.add('square').txtr(6);
   debugObj.add('square').turnY(Math.PI).txtr(6);

   // A BILLBOARD TURNS TO FACE A TARGET POINT

   let billboard = (node, pos, target, size) => {
      let yaw = Math.atan2(target[0] - pos[0], target[2] - pos[2]);
      node.identity().move(pos).turnY(-yaw).scale(size);
   }

   // INPUT

   inputEvents.onPress = hand => {
      if (suppress) return;
      let p = inputEvents.pos(hand);
      if (!placed) { placeAnchor(p); return; }
      if (transition < 1 || !p) return;
      if (mode == 1) {
         let mw = cg.add(gPos, cg.scale(mouse.pos, gScale));   // MOUSE CENTER, WORLD SPACE
         if (cg.distance(p, mw) < GRAB_R) {
            grabbed = hand;
            grabOffset = cg.subtract(mouse.pos, cg.scale(cg.subtract(p, gPos), 1 / gScale));
         }
      }
      else
         spawnCheese(hand);
   }
   inputEvents.onDrag = hand => {
      if (grabbed != hand) return;
      let p = inputEvents.pos(hand);
      if (!p) return;
      let c = cg.scale(cg.subtract(p, gPos), 1 / gScale);
      mouse.pos = cg.add(c, grabOffset);
      mouse.pos[1] = cg.clamp(mouse.pos[1], 0, .35);
   }
   inputEvents.onRelease = hand => {
      if (grabbed == hand) {
         grabbed = null;
         mouse.pos = [cg.clamp(mouse.pos[0], -SLAB_W/2 + .07, SLAB_W/2 - .07), mouse.pos[1],
                      cg.clamp(mouse.pos[2], -SLAB_D/2 + .07, SLAB_D/2 - .07)];
         mouse.pos[1] = cg.clamp(mouse.pos[1], 0, .35);
      }
      suppress = false;
   }
   inputEvents.onDoublePress = hand => toggleMode();

   let spawnCheese = hand => {
      let m = hand == 'left' ? bodyMatrix(handMatrix('left') || cg.mIdentity())
                             : bodyMatrix(handMatrix('right') || cg.mIdentity());
      let f = cg.normalize([m[8], 0, m[10]]);
      cheese = { pos: clampMini([m[12] + .06 * f[0], 0, m[14] + .06 * f[2]]), size: 1 };
      crumbTimer = 0;
   }

   if (!window.miniatureKeys) {
      window.miniatureKeys = true;
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
      let H  = headMatrix();
      let Lw = handMatrix('left'), Rw = handMatrix('right');

      // THE ONE MATRIX THAT MAPS MINIATURE SPACE TO THE WORLD
      // (BLEND TOWARD THE CURRENT MODE: MODE 1 SETTLES AT T(anchor) - STATIONARY)

      transition = Math.min(1, transition + dt / TRANSIT);
      let e = cg.ease(transition);
      let blend = mode == 2 ? e : 1 - e;
      let floorPt = [anchor[0], 0, anchor[2]];
      gPos = cg.mix(anchor, floorPt, blend);
      gScale = Math.pow(SCALE, blend);
      miniRoot.identity().move(gPos).scale(gScale);

      // MIRROR MY POSE INTO MINIATURE SPACE

      let A  = H ? bodyMatrix(H) : null;
      let Lm = Lw ? bodyMatrix(Lw) : null;
      let Rm = Rw ? bodyMatrix(Rw) : null;
      let aPos = A ? [A[12], A[13], A[14]] : [0, .14, 0];

      if (A) {
         meHead.setMatrix(A);
         meHead.opacity(mode == 2 ? 0 : 1);            // HIDE MY HEAD WHEN I AM INSIDE IT
         let hp = [H[12], H[13], H[14]];
         let chest = cg.mTransform(H, [0, -.2, 0]);
         let down = cg.normalize(cg.subtract(chest, hp));
         meTorso.identity().move(bodyPoint(chest)).scale(.15, .075, .045).opacity(1);
         arm(meHandL, upL, foL, cg.mTransform(H, [ .17, -.21, 0]), Lw, chest, down);
         arm(meHandR, upR, foR, cg.mTransform(H, [-.17, -.21, 0]), Rw, chest, down);
      }
      else {
         meHead.opacity(0); meTorso.opacity(0);
         hideArm(meHandL, upL, foL); hideArm(meHandR, upR, foR);
      }

      // CHEESE ECONOMY: THE MOUSE EATS A CHEESE WHEN IT GETS CLOSE ENOUGH

      let nibbling = cheese && !grabbed && cg.distance(mouse.pos, cheese.pos) < .03;
      if (nibbling) {
         cheese.size -= dt / CHEESE_T;
         crumbTimer -= dt;
         if (crumbTimer <= 0) { spawnCrumb(cheese.pos); crumbTimer = .4; }
         if (cheese.size <= .18) {
            for (let n = 0 ; n < 4 ; n++) spawnCrumb(cheese.pos);
            cheese = null;
         }
      }

      // THE MOUSE

      mouse.held = !!grabbed;
      mouse.update({ t, dt, cheese: cheese ? cheese.pos : null, nibbling,
                     handL: Lm ? [Lm[12], Lm[13], Lm[14]] : null,
                     handR: Rm ? [Rm[12], Rm[13], Rm[14]] : null,
                     mode });

      if (cheese) cheeseNode.identity().move(cheese.pos)
                   .scale(.02 * cheese.size, .013 * cheese.size, .016 * cheese.size).opacity(1);
      else cheeseNode.opacity(0);

      for (let n = 0 ; n < crumbs.length ; n++) {
         let c = crumbs[n];
         if (!c.active) { crumbNodes[n].opacity(0); continue; }
         c.age += dt;
         if (c.age > 3) { c.active = false; continue; }
         if (c.vel[0] || c.vel[1] || c.vel[2]) {
            c.vel[1] -= 2.5 * dt;
            c.pos = cg.add(c.pos, cg.scale(c.vel, dt));
            if (c.pos[1] < .004) { c.pos[1] = .004; c.vel = [0,0,0]; }
         }
         crumbNodes[n].identity().move(c.pos).scale(.0035)
           .opacity(c.age > 2 ? 1 - (c.age - 2) : 1);
      }

      // SIGNS

      if (signDirty) { drawSign(); signDirty = false; }
      billboard(sign, [0, .32, -.18], aPos, .16);
      sign.opacity(mode == 1 ? 1 : 0);

      if (debug) {
         if (t > nextDbg) { drawDebug(aPos); nextDbg = t + .2; }
         billboard(debugObj, [anchor[0], anchor[1] + .45, anchor[2]],
                   H ? [H[12], H[13], H[14]] : [0, 1.6, 0], .14);
         debugObj.opacity(1);
         boundsBox.opacity(.15);
         axes.opacity(1);
      }
      else {
         debugObj.opacity(0);
         boundsBox.opacity(0);
         axes.opacity(0);
      }

      // THE 1/12 CLASSROOM REPLICA IS ONLY WORN IN MINI-ME VIEW

      room.opacity(mode == 2 ? 1 : 0);
   });
}
