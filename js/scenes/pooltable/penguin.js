import * as cg from "../../render/core/cg.js";

// THE MINI AVATAR: A REBUILD OF THE CHARACTER-STUDIO PENGUIN
// (.context/attachments/43NacZ/avatar-penguin.html - SDF CHIBI WITH
// PINK FELT BODY #FA70AB, CREAM BELLY + CHEEKS, ORANGE BEAK/FEET,
// HEAD BOW, SIDE FLIPPERS), PORTED TO CLAY PRIMITIVES SO IT CAN WADDLE.
//
// THE PENGUIN IS A FULLY INDEPENDENT CHARACTER: IT NEVER MIRRORS THE
// USER'S HEAD OR CONTROLLERS. THE SCENE OWNS .pos AND .yaw; update(ctx)
// ONLY ANIMATES. totalHeight IS EXACTLY 152 mm = 6 IN AT 1/12 SCALE.
//
// ctx = { t, dt, moving, ride }   ride = true IN PENGUIN-POV MODE
// (THE CAMERA IS INSIDE THE HEAD, SO THE HEAD GROUP IS HIDDEN).

const UNIT_HEIGHT = .99;                        // SKULL TOP IN PENGUIN UNITS (BOW IS ORNAMENT)
const TOTAL_HEIGHT = .152;                      // 6 IN AT 1/12 SCALE
const SCALE_U = TOTAL_HEIGHT / UNIT_HEIGHT;

export const PENGUIN_HEIGHT = TOTAL_HEIGHT;
export const PENGUIN_EYE_H = .78 * SCALE_U;     // EYE MARKER HEIGHT ABOVE THE FELT

let PINK = [.98,.44,.67], CREAM = [.97,.93,.85], ORANGE = [.93,.64,.23], BOW = [1,.25,.45];

export function buildPenguin(model) {

   let root = model.add();                      // SCENE-OWNED: pos + yaw + waddle roll
   let u = root.add().scale(SCALE_U);           // STATIC UNIT SCALE (PERSISTS)

   let bodyG = u.add();                         // BOBS WITH THE WADDLE
   let body = bodyG.add('sphere').color(PINK);
   let belly = bodyG.add('sphere').color(CREAM);
   let flipL = bodyG.add(), flipR = bodyG.add();
   let flipLFin = flipL.add('sphere').color(PINK);
   let flipRFin = flipR.add('sphere').color(PINK);
   let footL = u.add('sphere').color(ORANGE);   // PLANTED ON THE GROUND, NOT BOBBED
   let footR = u.add('sphere').color(ORANGE);

   let head = bodyG.add();                      // PIVOT FOR IDLE LOOK-AROUND
   let skull = head.add('sphere').color(PINK);
   let cheekL = head.add('sphere').color(CREAM), cheekR = head.add('sphere').color(CREAM);
   let eyeL = head.add('sphere').color('black'), eyeR = head.add('sphere').color('black');
   let glintL = head.add('sphere').color('white'), glintR = head.add('sphere').color('white');
   let beak = head.add('coneZ').color(ORANGE);
   let bowKnot = head.add('sphere').color(BOW);
   let bowL = head.add('sphere').color(BOW), bowR = head.add('sphere').color(BOW);

   const peng = { pos: [0, 0, .22], yaw: 2.8, visible: true, update };

   let phase = 0, lookYaw = 0, lookUntil = 1.5, twitchUntil = 0;

   function update(ctx) {
      let t = ctx.t, dt = Math.min(ctx.dt, .1);
      phase += dt * (ctx.moving ? 11 : 2);

      if (t > lookUntil) {                      // IDLE: GLANCE AROUND, TWITCH A FLIPPER
         lookUntil = t + 2.5 + 2 * Math.random();
         lookYaw = (Math.random() - .5) * 1.2;
         if (Math.random() < .4) twitchUntil = t + .5;
      }
      let look = ctx.moving ? 0 : cg.mixAngle(head._look || 0, lookYaw, Math.min(1, 4 * dt));
      head._look = look;
      let twitch = t < twitchUntil ? Math.sin(20 * t) * .3 : 0;
      let bob = ctx.moving ? Math.abs(Math.sin(phase)) * .015 : Math.sin(phase) * .004;
      let rock = ctx.moving ? Math.sin(phase) * .09 : 0;

      root.identity().move(peng.pos).turnY(peng.yaw).turnZ(rock)
          .opacity(peng.visible === false ? 0 : 1);

      body.identity().move([0, .42 + bob, 0]).scale(.42, .46, .40);
      belly.identity().move([0, .32 + bob, -.22]).scale(.30, .33, .20);
      flipL.identity().move([-.36, .55 + bob, 0]).turnZ(.3 + (ctx.moving ? Math.sin(phase) * .35 : twitch))
           .turnX(twitch);
      flipLFin.identity().move([0, -.12, 0]).scale(.07, .19, .10);
      flipR.identity().move([ .36, .55 + bob, 0]).turnZ(-.3 - (ctx.moving ? Math.sin(phase) * .35 : twitch))
           .turnX(twitch);
      flipRFin.identity().move([0, -.12, 0]).scale(.07, .19, .10);
      let step = ctx.moving ? Math.sin(phase) * .04 : 0;
      footL.identity().move([-.13, .013, -.02 + step]).scale(.08, .025, .11);
      footR.identity().move([ .13, .013, -.02 - step]).scale(.08, .025, .11);

      head.identity().move([0, bob, 0]).turnY(look);
      skull.identity().move([0, .72, -.02]).scale(.30, .27, .27);
      cheekL.identity().move([-.11, .70, -.24]).scale(.10, .09, .05);
      cheekR.identity().move([ .11, .70, -.24]).scale(.10, .09, .05);
      eyeL.identity().move([-.11, .78, -.24]).scale(.045);
      eyeR.identity().move([ .11, .78, -.24]).scale(.045);
      glintL.identity().move([-.09, .80, -.27]).scale(.014);
      glintR.identity().move([ .09, .80, -.27]).scale(.014);
      beak.identity().move([0, .73, -.29]).turnY(Math.PI).scale(.05, .05, .10);
      bowKnot.identity().move([0, 1.0, .02]).scale(.035);
      bowL.identity().move([-.055, 1.01, .02]).turnZ(.5).scale(.05, .03, .02);
      bowR.identity().move([ .055, 1.01, .02]).turnZ(-.5).scale(.05, .03, .02);

      // IN PENGUIN-POV MODE THE CAMERA SITS INSIDE THE HEAD - HIDE THE HEAD GROUP
      head.opacity(ctx.ride ? 0 : 1);
   }

   return peng;
}
