import * as cg from "../../render/core/cg.js";

// THE MINIATURE OBJECT: A MOUSE YOU CAN PICK UP (MODE 1) AND FEED CHEESE (MODE 2).
// GEOMETRY IS IN MINIATURE-SPACE METERS: THE SLAB TOP IS y = 0, AND THE MOUSE
// FACES -z WHEN yaw = 0.
//
// buildMouse(model, bounds) RETURNS A HANDLE:
//    .pos   - [x,y,z] GROUND POSITION. THE SCENE MAY REWRITE THIS TO GRAB/DRAG IT.
//    .held  - SET true WHILE THE USER IS CARRYING IT (MOUSE SQUIRMS AND DANGLES).
//    .update(ctx) - ADVANCE BEHAVIOR AND REDRAW EVERY FRAME.
//          ctx = { t, dt, cheese, nibbling, handL, handR, mode }
//          cheese/handL/handR are points in miniature space (or null).

export function buildMouse(model, bounds) {

   const WALK = .15, FLEE = .4;    // SPEEDS IN MINIATURE METERS PER SECOND

   let fur = [.42,.38,.35], pink = [.9,.65,.62];

   let root = model.add();
   let body = root.add('sphere').color(fur);
   let head = root.add();                       // PIVOT FOR SNIFF/NIBBLE BOBS
   let skull = head.add('sphere').color(fur);
   let snout = head.add('coneZ').color(fur);
   let earL = head.add('diskX').color(pink), earR = head.add('diskX').color(pink);
   let eyeL = head.add('sphere').color('black'), eyeR = head.add('sphere').color('black');
   let tail = [];
   for (let n = 0 ; n < 3 ; n++)
      tail.push(root.add('sphere').color(pink));
   let feet = [];
   for (let n = 0 ; n < 4 ; n++)
      feet.push(root.add('sphere').color(pink));

   let mouse = { pos: [.45, 0, .12], yaw: 2.4, held: false, update };

   // BEHAVIOR STATE
   let state = 'sniff', stateUntil = 0, wanderTo = null, lookYaw = 0;
   let fleeUntil = 0, fleeDir = [1,0,0];

   let clampToSlab = p => [
      cg.clamp(p[0], -bounds.w/2 + .07, bounds.w/2 - .07), 0,
      cg.clamp(p[2], -bounds.d/2 + .07, bounds.d/2 - .07)];

   let face = (dir, dt) =>
      mouse.yaw = cg.mixAngle(mouse.yaw, Math.atan2(-dir[0], -dir[2]), Math.min(1, 10 * dt));

   let step = (dir, len, dt) => {
      mouse.pos = clampToSlab(cg.add(mouse.pos, cg.scale(dir, len)));
      face(dir, dt);
   }

   function update(ctx) {
      let t = ctx.t, dt = Math.min(ctx.dt, .1);
      let bob = 0, roll = 0, headPitch = 0, wiggle = 0, tailUp = 0;

      if (mouse.held) {                                   // DANGLE AND SQUIRM WHILE CARRIED
         roll = .3 * Math.sin(6 * t);
         wiggle = 1;
      }
      else if (ctx.nibbling) {                            // EAT: BOB THE HEAD RAPIDLY
         headPitch = .45 * Math.sin(14 * t);
         tailUp = 1;
      }
      else {
         if (mouse.pos[1] > 0)                            // SETTLE AFTER A DROP
            mouse.pos[1] = Math.max(0, mouse.pos[1] - 1.5 * dt);

         let startle = null;                              // A TOO-CLOSE HAND
         for (let h of [ctx.handL, ctx.handR])
            if (h && cg.distance(h, mouse.pos) < .07) startle = h;
         if (startle && t > fleeUntil) {
            stateUntil = t + 1;
            if (ctx.mode == 2) {                          // GIANT HAND: RUN FOR IT
               state = 'flee';
               stateUntil = fleeUntil = t + 1.2;
               let d = [mouse.pos[0] - startle[0], 0, mouse.pos[2] - startle[2]];
               fleeDir = cg.norm(d) > .001 ? cg.normalize(d) : [1,0,0];
            }
            else                                          // GOD HAND: FREEZE AND COWER
               state = 'freeze';
         }

         if (state == 'flee' && t < fleeUntil) {          // SCURRY AWAY
            step(fleeDir, FLEE * dt, dt);
            wiggle = 1;
            bob = Math.abs(Math.sin(18 * t)) * .006;
         }
         else if (ctx.cheese) {                           // SEEK THE CHEESE
            let d = cg.subtract(ctx.cheese, mouse.pos); d[1] = 0;
            if (cg.norm(d) > .028) {
               step(cg.normalize(d), WALK * dt, dt);
               wiggle = 1;
               bob = Math.abs(Math.sin(12 * t)) * .005;
            }
            tailUp = 1;
         }
         else {                                           // IDLE MICRO-BEHAVIORS
            if (t > stateUntil) {
               state = ['sniff','look','wander'][3 * Math.random() >> 0];
               stateUntil = t + 2 + 2 * Math.random();
               if (state == 'look'  ) lookYaw = mouse.yaw + (Math.random() - .5) * 2;
               if (state == 'wander') {
                  let a = 2 * Math.PI * Math.random();
                  wanderTo = clampToSlab([mouse.pos[0] + .25 * Math.cos(a), 0,
                                          mouse.pos[2] + .25 * Math.sin(a)]);
               }
            }
            if (state == 'sniff') headPitch = .25 * Math.sin(7 * t);
            if (state == 'freeze') headPitch = .12 * Math.sin(20 * t);
            if (state == 'look')  mouse.yaw = cg.mixAngle(mouse.yaw, lookYaw, Math.min(1, 4 * dt));
            if (state == 'wander' && wanderTo) {
               let d = cg.subtract(wanderTo, mouse.pos); d[1] = 0;
               if (cg.norm(d) > .02) {
                  step(cg.normalize(d), .4 * WALK * dt, dt);
                  wiggle = 1;
                  bob = Math.abs(Math.sin(9 * t)) * .004;
               }
            }
         }
      }

      // REDRAW (clay TRANSFORMS ARE RELATIVE: REBUILD THE WHOLE POSE EVERY FRAME)
      root.identity().move(mouse.pos).turnY(mouse.yaw).turnZ(roll);
      body.identity().move([0, .026 + bob, 0]).scale(.028, .022, .048);
      head.identity().move([0, .04 + bob, -.036]).turnX(headPitch);
      skull.identity().scale(.02);
      snout.identity().move([0, -.003, -.015]).turnY(Math.PI).scale(.008, .007, .015);
      earL.identity().move([ .014, .014, -.002]).turnZ( .3).scale(.011);
      earR.identity().move([-.014, .014, -.002]).turnZ(-.3).scale(.011);
      eyeL.identity().move([ .009, .005, -.017]).scale(.0035);
      eyeR.identity().move([-.009, .005, -.017]).scale(.0035);
      for (let n = 0 ; n < 3 ; n++)
         tail[n].identity().move([n ? Math.sin(6 * t + n) * .006 * (tailUp ? 1.5 : .5) : 0,
                                  .022 - .005 * n + tailUp * .01 * n,
                                  .048 + .017 * n]).scale(.0055 - .0013 * n);
      for (let n = 0 ; n < 4 ; n++)
         feet[n].identity().move([n & 1 ? .02 : -.02,
                                  .007 + (wiggle ? Math.max(0, Math.sin(18 * t + n * 1.6)) * .009 : 0),
                                  n & 2 ? .026 : -.022]).scale(.0075);
   }

   return mouse;
}
