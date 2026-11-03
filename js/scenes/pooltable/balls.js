import * as cg from "../../render/core/cg.js";

// THE MINIATURE OBJECTS: 15 RACKED POOL BALLS + CUE BALL ON THE FELT.
// ALL GEOMETRY IS IN MINIATURE-SPACE METERS: FELT TOP IS y = 0.
// THE SCENE MAY SET .held AND REWRITE .pos OF ANY BALL (MODE-1 GRAB).
// update(dt, peng) ADVANCES PHYSICS AND REDRAWS; peng = {pos, speed, r}
// IS THE PENGUIN - ITS BODY BUMPS BALLS AROUND.

const R = .019;                                 // BALL RADIUS, MINIATURE METERS
const REST_WALL = .7, REST_BALL = .9;           // RESTITUTIONS
const FRICTION = .25;                           // VELOCITY Multiplier AFTER 1 SECOND
const RESPAWN_S = 2.5;                          // SECONDS IN A POCKET BEFORE RESPAWN

let COLORS = [
   [.95,.95,.95],                               // CUE
   [.9,.7,.1], [.15,.3,.8], [.85,.15,.15], [.5,.2,.7], [.95,.5,.1],
   [.1,.6,.3], [.6,.15,.2], [.1,.1,.12], [.9,.7,.1], [.15,.3,.8],
   [.85,.15,.15], [.5,.2,.7], [.95,.5,.1], [.1,.6,.3], [.6,.15,.2]];

export function buildBalls(model, table) {

   let balls = [];
   let gap = .048;
   for (let i = 0, n = 0 ; n < 5 ; n++)          // RACK TRIANGLE, APEX TOWARD -z
      for (let j = 0 ; j <= n ; j++, i++) {
         let x = (j - n/2) * gap, z = -(table.d/2 - .22) + n * gap * .87;
         balls.push({ pos: [x, R, z], home: [x, R, z], vel: [0,0,0],
                      active: true, timer: 0, age: 1, held: false,
                      node: model.add('sphere').color(COLORS[i]) });
      }
   let cue = { pos: [0, R, table.d/2 - .2], home: [0, R, table.d/2 - .2], vel: [0,0,0],
               active: true, timer: 0, age: 1, held: false,
               node: model.add('sphere').color(COLORS[0]) };
   balls.unshift(cue);

   let limX = table.w/2 - R - .005, limZ = table.d/2 - R - .005;
   let pockets = [];
   for (let sx = -1 ; sx <= 1 ; sx += 2)
      for (let sz = -1 ; sz <= 1 ; sz += 2)
         pockets.push([sx * (table.w/2 - .06), sz * (table.d/2 - .06)]);
   pockets.push([0, -(table.d/2 - .01)], [0, table.d/2 - .01]);

   function update(dt, peng) {
      dt = Math.min(dt, .1);
      let damp = Math.pow(FRICTION, dt);

      for (let b of balls) {
         if (b.held) { b.age += dt; continue; }   // THE SCENE OWNS A HELD BALL

         if (!b.active) {                         // IN A POCKET: SINK, WAIT, RESPAWN
            b.timer -= dt;
            if (b.timer <= 0) {
               b.active = true; b.age = 0;
               b.pos = b.home.slice(); b.vel = [0,0,0];
            }
            continue;
         }

         b.age += dt;
         b.vel = cg.scale(b.vel, damp);
         b.pos = cg.add(b.pos, cg.scale(b.vel, dt));
         b.vel[1] = 0;                          // BALLS LIVE ON THE FELT PLANE ONLY:
         b.pos[1] = R;                          // NO FORCES MAY LIFT THEM OFF THE TABLE

         for (let a of [0, 2]) {                  // RAILS
            let lim = a ? limZ : limX;
            if (b.pos[a] > lim)      { b.pos[a] = lim;      if (b.vel[a] > 0) b.vel[a] *= -REST_WALL; }
            if (b.pos[a] < -lim)     { b.pos[a] = -lim;     if (b.vel[a] < 0) b.vel[a] *= -REST_WALL; }
         }

         for (let p of pockets)                   // POCKETS
            if (cg.distance([b.pos[0], b.pos[2]], p) < table.pocketR - .006) {
               b.active = false;
               b.timer = RESPAWN_S;
            }
      }

      for (let i = 0 ; i < balls.length ; i++)    // BALL-BALL COLLISIONS
         for (let j = i + 1 ; j < balls.length ; j++) {
            let a = balls[i], b = balls[j];
            if (!a.active || !b.active || a.held || b.held) continue;
            let d = cg.subtract(a.pos, b.pos), dist = cg.norm(d);
            if (dist > 2 * R || dist < 1e-6) continue;
            let n = cg.normalize(d), overlap = 2 * R - dist;
            a.pos = cg.add(a.pos, cg.scale(n, overlap/2));
            b.pos = cg.add(b.pos, cg.scale(n, -overlap/2));
            let vrel = cg.dot(cg.subtract(a.vel, b.vel), n);
            if (vrel < 0) {
               let imp = vrel * (1 + REST_BALL) / 2;
               a.vel = cg.add(a.vel, cg.scale(n, -imp));
               b.vel = cg.add(b.vel, cg.scale(n,  imp));
            }
         }

      if (peng)                                   // PENGUIN BODY-PUSH
         for (let b of balls) {
            if (!b.active || b.held) continue;
            let d = cg.subtract(b.pos, [peng.pos[0], 0, peng.pos[2]]), dist = cg.norm(d);
            let rr = R + peng.r;
            if (dist < rr && dist > 1e-6) {
               let n = cg.normalize(d);
               b.pos = cg.add([peng.pos[0], 0, peng.pos[2]], cg.scale(n, rr));
               let sp = Math.max(peng.speed, .8);
               b.vel = cg.add(cg.scale(n, sp * .9 + .15), cg.scale(b.vel, .4));
            }
         }

      for (let b of balls) {                      // REDRAW
         if (!b.active) {
            b.node.opacity(b.timer > RESPAWN_S - .2 ? 1 : 0);     // SINK-OUT FLASH
            if (b.timer > RESPAWN_S - .2)
               b.node.identity().move(b.pos).scale(R * (RESPAWN_S - b.timer) / .2);
            else b.node.opacity(0);
            continue;
         }
         let s = R * Math.min(1, b.age / .3);     // POP-IN ON RESPAWN
         b.node.identity().move(b.pos).scale(s).opacity(1);
      }
   }

   return { balls, update, R, pickBall };
}

// AIM RAY PICKER: FIRST ACTIVE BALL THE HORIZONTAL RAY FROM (ox,oz) ALONG
// (dx,dz) TOUCHES (RAY RUNS AT BALL-CENTER HEIGHT). RETURNS {ball, dist} OR NULL.

export function pickBall(balls, ox, oz, dx, dz, maxDist) {
   let best = null;
   for (let b of balls) {
      if (!b.active || b.held) continue;
      let rx = b.pos[0] - ox, rz = b.pos[2] - oz;
      let t = rx * dx + rz * dz;
      if (t < .02 || t > maxDist) continue;
      let px = rx - t * dx, pz = rz - t * dz;
      if (Math.hypot(px, pz) > R + .019) continue;
      if (!best || t < best.dist) best = { ball: b, dist: t };
   }
   return best;
}
