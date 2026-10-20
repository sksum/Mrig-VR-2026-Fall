import * as cg from '../render/core/cg.js';
import { stl } from '../render/core/stl.js';
import { buttonState, joyStickState } from '../render/core/controllerInput.js';

// DIGITAL DOUBLE OF AN SO101 EDUCATIONAL ROBOT ARM
//
// LEFT CONTROLLER TELEOPERATION (THUMBSTICK VELOCITY CONTROL):
//    thumbstick X/Y - move the picker horizontally
//    trigger        - raise the picker (analog)
//    squeeze/grip   - lower the picker (analog)
//    thumbstick press - toggle the jaw open/closed
//    right trigger click - spawn a ball at the right controller

let motion = time => [         // EXAMPLE OF JOINT ANIMATION INPUT FOR THE ROBOT ARM
  .3 * Math.cos(time * 1.2),
  .3 * Math.sin(time * 1.3),
  .3 * Math.cos(time * 1.4),
  .3 * Math.sin(time * 1.5),
  .3 * Math.cos(time * 1.6),
  .2 * Math.sin(time * 1.7)
];

export const init = async model => {
   const printed = [1,.82,.12], motor = [.1,.1,.1];     // COLOR PALETTE FOR THE ROBOT PARTS

   // THE MESH OF EACH LINK IS THE NAME OF A FILE IN media/stl/SO101. EACH LINK'S xyz AND rpy ARE RELATIVE TO THAT LINK'S FRAME.

   const links = {
      base_link: [
         { stl: 'base_motor_holder_so101_v1'       , xyz: [-0.00636471, -0.0000994414, -0.0024], rpy: [1.5708, 0, 1.5708], color: printed },
         { stl: 'base_so101_v2'                    , xyz: [-0.00636471, 0, -0.0024], rpy: [1.5708, 0, 1.5708], color: printed },
         { stl: 'sts3215_03a_v1'                   , xyz: [0.0263353, 0, 0.0437], rpy: [0, 0, 0], color: motor },
         { stl: 'waveshare_mounting_plate_so101_v2', xyz: [-0.0309827, -0.000199441, 0.0474], rpy: [1.5708, 0, 1.5708], color: printed },
      ],
      shoulder_link: [
         { stl: 'sts3215_03a_v1'            , xyz: [-0.0303992, 0.000422241, -0.0417], rpy: [1.5708, 1.5708, 0], color: motor },
         { stl: 'motor_holder_so101_base_v1', xyz: [-0.0675992, -0.000177759, 0.0158499], rpy: [1.5708, -1.5708, 0], color: printed },
         { stl: 'rotation_pitch_so101_v1'   , xyz: [0.0122008, 0.0000222413, 0.0464], rpy: [-1.5708, 0, 0], color: printed },
      ],
      upper_arm_link: [
         { stl: 'sts3215_03a_v1'    , xyz: [-0.11257, -0.0155, 0.0187], rpy: [-3.14159, 0, -1.5708], color: motor },
         { stl: 'upper_arm_s0101_v1', xyz: [-0.065085, 0.012, 0.0182], rpy: [3.14159, 0, 0], color: printed },
      ],
      lower_arm_link: [
         { stl: 'under_arm_so101_v1'         , xyz: [-0.0648499, -0.032, 0.0182], rpy: [3.14159, 0, 0], color: printed },
         { stl: 'motor_holder_so101_wrist_v1', xyz: [-0.0648499, -0.032, 0.018], rpy: [-3.14159, 0, 0], color: printed },
         { stl: 'sts3215_03a_v1'             , xyz: [-0.1224, 0.0052, 0.0187], rpy: [-3.14159, 0, -3.14159], color: motor },
      ],
      wrist_link: [
         { stl: 'sts3215_03a_no_horn_v1'   , xyz: [0, -0.0424, 0.0306], rpy: [1.5708, 1.5708, 0], color: motor },
         { stl: 'wrist_roll_pitch_so101_v2', xyz: [0, -0.028, 0.0181], rpy: [-1.5708, -1.5708, 0], color: printed },
      ],
      gripper_link: [
         { stl: 'sts3215_03a_v1'              , xyz: [0.0077, 0.0001, -0.0234], rpy: [-1.5708, 0, 0], color: motor },
         { stl: 'wrist_roll_follower_so101_v1', xyz: [0, -0.000218214, 0.000949706], rpy: [-3.14159, 0, 0], color: printed },
      ],
      gripper_frame_link: [],
      moving_jaw_so101_v1_link: [
         { stl: 'moving_jaw_so101_v1', xyz: [0, 0, 0.0189], rpy: [0, 0, 0], color: printed },
      ],
   };

   const joints = [
      { name: 'shoulder_pan' , parent: 'robotBaseFrame', xyz: [ 0.0388353,  0          ,  0.0624   ], rpy: [ 3.14159, 0        , -3.14159], lo: -1.91986 , hi: 1.91986, link: 'shoulder_link'            },
      { name: 'shoulder_lift', parent: 'shoulder_pan'  , xyz: [-0.0303992, -0.0182778  , -0.0542   ], rpy: [-1.5708 ,-1.5708   ,  0      ], lo: -1.74533 , hi: 1.74533, link: 'upper_arm_link'           },
      { name: 'elbow_flex'   , parent: 'shoulder_lift' , xyz: [-0.11257  , -0.028      ,  0        ], rpy: [ 0      , 0        ,  1.5708 ], lo: -1.69    , hi: 1.69   , link: 'lower_arm_link'           },
      { name: 'wrist_flex'   , parent: 'elbow_flex'    , xyz: [-0.1349   ,  0.0052     ,  0        ], rpy: [ 0      , 0        , -1.5708 ], lo: -1.65806 , hi: 1.65806, link: 'wrist_link'               },
      { name: 'wrist_roll'   , parent: 'wrist_flex'    , xyz: [ 0        , -0.0611     ,  0.0181   ], rpy: [ 1.5708 , 0.0486795,  3.14159], lo: -2.74385 , hi: 2.84121, link: 'gripper_link'             },
      { name: 'gripper'      , parent: 'wrist_roll'    , xyz: [ 0.0202   ,  0.0188     , -0.0234   ], rpy: [ 1.5708 , 0        ,  0      ], lo: -0.174533, hi: 1.74533, link: 'moving_jaw_so101_v1_link' },
      { name: 'gripper_frame', parent: 'wrist_roll'    , xyz: [-0.0079   , -0.000218121, -0.0981274], rpy: [ 0      , 3.14159  ,  0      ], fixed: true,                link: 'gripper_frame_link'       },
   ];

   for (const meshList of Object.values(links))         // START LOADING THE ROBOT PARTS
      for (let mesh of meshList)
            stl('SO101/' + mesh.stl);

   let robotBaseFrame = model.add().move(-.1,1.5,0).turnX(-Math.PI/2);

   let node = {};                                        // CREATE THE KINEMATIC JOINT HIERARCHY
   node['robotBaseFrame'] = robotBaseFrame;
   for (let j of joints)
      node[j.name] = node[j.parent].add();

   ///////////////// TELEOPERATION STATE /////////////////

   let m = [0,0,0,0,0,0];                                // CURRENT JOINT ANGLE OFFSETS
   let target = null, lastTime = 0;
   let jawT = 0, jawOpen = false;                        // 0 = OPEN, 1 = CLOSED
   let measured = false, axis = [], pivot = [], S = null, R = 0;
   let balls = [], holding = -1;
   let trail = [], lastTrailT = 0, lastPanelT = 0, atLimit = false, wasLimit = false, prevStick = false;
   const SPEED = 0.06, DEADZONE = 0.15, BALL_R = 0.012;  // PICKER SPEED (m/s) AND STICK DEADZONE

   const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

   let applyM = () => {                                  // POSE THE ARM FROM THE JOINT OFFSETS
      let i = 0;
      for (let j of joints) {
         let z = j.rpy[2], y = j.rpy[1], x = j.rpy[0];
         switch (i) {
         case 0: case 2: case 3: z += m[i]; break;
         case 1: case 4: case 5: y += m[i]; break;
         }
         node[j.name].identity().move(j.xyz).turnZ(z).turnY(y).turnX(x);
         i++;
      }
   };

   // ONE-TIME NUMERICAL CALIBRATION OF THE IK JOINTS: PERTURB EACH JOINT SLIGHTLY
   // AND READ OFF ITS WORLD ROTATION AXIS AND PIVOT FROM THE FORWARD KINEMATICS.

   let col = (M,c) => [M[4*c], M[4*c+1], M[4*c+2]];
   let row = (M,r) => [M[r], M[4+r], M[8+r]];           // ROW r OF THE 3x3 ROTATION PART
   let measure = () => {
      applyM();
      for (let i = 0 ; i < 3 ; i++) {
         let M0 = node[joints[i].name].getGlobalMatrix();
         m[i] = 0.01; applyM();
         let M1 = node[joints[i].name].getGlobalMatrix();
         let d = [];                                     // D = R1 * R0^T
         for (let r = 0 ; r < 3 ; r++) d.push([0,0,0]);
         for (let r = 0 ; r < 3 ; r++)
            for (let c = 0 ; c < 3 ; c++)
               d[r][c] = cg.dot(row(M1,r), col(M0,c));
         let a = [d[2][1]-d[1][2], d[0][2]-d[2][0], d[1][0]-d[0][1]];
         axis[i] = cg.normalize(a);
         pivot[i] = node[joints[i].name].getGlobalPos();
         m[i] = 0;
      }
      applyM();
      S = pivot[1];                                      // REACH SPHERE IS CENTERED AT THE SHOULDER
      let tip = node.gripper.getGlobalPos();
      let e = node.elbow_flex.getGlobalPos(), w = node.wrist_flex.getGlobalPos();
      R = cg.distance(S, e) + cg.distance(e, w) + cg.distance(w, tip);
      target = tip.slice();
      reachDisk.identity().move([S[0], S[1] - 0.12, S[2]])   // REACH FOOTPRINT ON THE FLOOR
               .turnX(Math.PI/2).scale(R, R, 1).opacity(.07).color(1,.3,.3);
   };

   // DIFFERENTIAL IK: LOCALLY LINEARIZE EACH JOINT'S EFFECT ON THE GRIPPER TIP
   // (VELOCITY = ANGLE RATE * cross(axis, tip - PIVOT)) AND TAKE A NEWTON STEP.

   let solveIK = () => {
      for (let it = 0 ; it < 8 ; it++) {
         applyM();
         let tip = node.gripper.getGlobalPos();
         let err = cg.subtract(target, tip);
         for (let i = 0 ; i < 3 ; i++) {
            let J = cg.cross(axis[i], cg.subtract(tip, pivot[i]));
            let jj = cg.dot(J, J);
            if (jj > 1e-9)
               m[i] = clamp(m[i] + clamp(0.9 * cg.dot(err, J) / jj, -0.05, 0.05),
                            joints[i].lo, joints[i].hi);
         }
      }
      m[3] = clamp(-(m[1] + m[2]), joints[3].lo, joints[3].hi);   // KEEP THE GRIPPER ROUGHLY LEVEL
      applyM();
   };

   ///////////////// ANNOTATION VISUALS /////////////////

   let helpRoot = model.add().move(-.5, 1.9, -.2).scale(.35);
   helpRoot.add(clay.text(['SO101 TELEOPERATION',
                           '',
                           'thumbstick: move picker',
                           'trigger: raise   squeeze: lower',
                           'thumbstick press: open / close jaw',
                           'right trigger click: new ball'].join('\n'))).color(1,1,1);

   let ghost = model.add('sphere').scale(.01).opacity(.35).color(.3,.8,1);
   let beam = model.add('tubeZ').scale(.001,.001,1).opacity(.4).color(.3,.8,1);
   let trailRoot = model.add();
   let ballRoot = model.add();
   let labelRoot = model.add();                          // ON-PART JOINT LABELS + JOINT DOTS
   let dotRoot = model.add();
   let reachDisk = model.add('diskZ');                   // REACH FOOTPRINT ON THE "FLOOR"

   inputEvents.onClick = hand => {                       // SPAWN A BALL AT THE RIGHT CONTROLLER
      if (hand !== 'right' || !S)
         return;
      let p = inputEvents.pos(hand).slice();
      let d = cg.subtract(p, S);
      let len = cg.norm(d);
      if (len > 0.8 * R)                                 // KEEP SPAWN POINTS WITHIN REACH
         p = cg.add(S, cg.scale(d, 0.8 * R / len));
      balls.push({ pos: p, node: null });
   };

   model.animate(() => {
      for(let mesh of links['base_link']) {             // CREATE THE ROBOT BASE
         let partName = 'SO101/' + mesh.stl;
         if (clay.formMesh(partName) && ! mesh.part)
            mesh.part = node['robotBaseFrame'].add(partName).move(mesh.xyz)
                                                            .turnZ(mesh.rpy[2])
                                                            .turnY(mesh.rpy[1])
                                                            .turnX(mesh.rpy[0])
                                                            .color(mesh.color);
      }

      for(let j of joints)                              // CREATE THE ALL THE OTHER ROBOT PARTS
      for(let mesh of links[j.link]) {
         let partName = 'SO101/' + mesh.stl;
         if (clay.formMesh(partName) && ! mesh.part)
            mesh.part = node[j.name].add(partName).move(mesh.xyz)
                                                  .turnZ(mesh.rpy[2])
                                                  .turnY(mesh.rpy[1])
                                                  .turnX(mesh.rpy[0])
                                                  .color(mesh.color);
      }

      let hasCtrl = buttonState.left && buttonState.left.length > 0;

      if (! measured) {                                 // ONE-TIME GEOMETRY CALIBRATION
         measure();
         measured = true;
         balls.push({ pos: cg.add(target, [.05, -.04, .05]) });   // STARTER BALL NEXT TO THE ARM
      }

      // THUMBSTICK VELOCITY CONTROL: STICK = HORIZONTAL, TRIGGER = UP, SQUEEZE = DOWN

      let dt = Math.min(0.05, model.time - lastTime);
      lastTime = model.time;

      if (hasCtrl && target) {
         let dz = v => Math.abs(v) < DEADZONE ? 0 : v;   // STICK DEADZONE
         let sx = dz(joyStickState.left.x), sy = dz(joyStickState.left.y);
         let up   = buttonState.left[0] ? buttonState.left[0].value : 0;
         let down = buttonState.left[1] ? buttonState.left[1].value : 0;

         let raw = cg.add(target, cg.scale([sx, up - down, -sy], SPEED * dt));

         let d = cg.subtract(raw, S), len = cg.norm(d);
         atLimit = len > 0.97 * R;                       // CLAMP TO THE REACH LIMIT (SILENT)
         if (atLimit)
            raw = cg.add(S, cg.scale(d, 0.97 * R / len));
         if (atLimit && ! wasLimit)                      // ONE PULSE WHEN HITTING THE LIMIT
            vibrate('left', .5, 60);
         wasLimit = atLimit;
         target = raw;
         solveIK();
      }
      else {
         let mm = motion(model.time);                    // IDLE WIGGLE UNTIL A CONTROLLER APPEARS
         for (let i = 0 ; i < 6 ; i++)
            m[i] += (mm[i] - m[i]) * 0.05;
         applyM();
      }

      // THUMBSTICK PRESS → TOGGLE JAW, AND BALL PICKUP / RELEASE

      let stickNow = hasCtrl && buttonState.left[3] && buttonState.left[3].pressed;
      if (stickNow && ! prevStick) {
         jawOpen = ! jawOpen;
         vibrate('left', .4, 20);
      }
      prevStick = stickNow;
      jawT = cg.mix(jawT, jawOpen ? 1 : 0, 0.3);
      m[5] = joints[5].lo + jawT * (joints[5].hi - joints[5].lo);
      applyM();

      let tip = node.gripper.getGlobalPos();
      if (jawT > 0.6 && holding < 0) {                   // GRAB A NEARBY BALL WHEN JAW CLOSES
         for (let i = 0 ; i < balls.length ; i++)
            if (cg.distance(balls[i].pos, tip) < BALL_R + 0.02) {
               holding = i;
               vibrate('left', 1, 20);
               break;
            }
      }
      if (holding >= 0) {
         if (jawT > 0.4)
            balls[holding].pos = cg.add(tip, cg.scale(cg.normalize(cg.subtract(tip, pivot[1])), 0.01));
         else
            holding = -1;                                // RELEASE: BALL STAYS WHERE DROPPED
      }

      // VISUALS: TARGET GHOST, BASE→TIP BEAM, TRAIL, BALLS

      ghost.identity().move(hasCtrl && target ? target : [0,10,0]);
      beam.placeLimb(S, tip, 0.0012);

      if (model.time - lastTrailT > 0.05) {
         lastTrailT = model.time;
         trail.push(tip.slice());
         if (trail.length > 60)
            trail.shift();
      }
      while (trailRoot.nChildren() > 0)
         trailRoot.remove(0);
      for (let i = 0 ; i < trail.length ; i++)
         trailRoot.add('sphere').move(trail[i]).scale(.004).opacity(.02 + .28 * i / trail.length).color(.3,.8,1);

      while (ballRoot.nChildren() > 0)
         ballRoot.remove(0);
      for (let b of balls)
         ballRoot.add('sphere').move(b.pos).scale(BALL_R).color(1,.6,.2);

      // JOINT DOTS AT EVERY PIVOT (THE KINEMATIC CHAIN)

      while (dotRoot.nChildren() > 0)
         dotRoot.remove(0);
      for (let i = 0 ; i < 6 ; i++) {
         let p = node[joints[i].name].getGlobalPos();
         dotRoot.add('sphere').move(p).scale(.005)
                 .color(m[i] <= joints[i].lo + 1e-3 || m[i] >= joints[i].hi - 1e-3 ? 1 : 0, .8, .2);
      }

      // ON-PART LABELS: ANGLE AT EACH JOINT, FORCE + STATE AT THE GRIPPER (5 HZ)

      if (model.time - lastPanelT > 0.2) {
         lastPanelT = model.time;
         while (labelRoot.nChildren() > 0)
            labelRoot.remove(0);
         for (let i = 0 ; i < 6 ; i++) {
            let deg = (m[i] * 180 / Math.PI).toFixed(0);
            let pinned = m[i] <= joints[i].lo + 1e-3 ? ' MIN'
                       : m[i] >= joints[i].hi - 1e-3 ? ' MAX' : '';
            let lines = joints[i].name + ' ' + deg + ' deg' + (pinned ? '\nAT' + pinned : '');
            if (i == 5)                                   // GRIPPER: FORCE + JAW STATE
               lines = 'jaw ' + (holding >= 0 ? 'HOLDING' : jawT > .5 ? 'CLOSED' : 'OPEN')
                     + '\nF ' + (holding >= 0 ? '0.49' : '0.00') + ' N';
            let p = node[joints[i].name].getGlobalPos();
            let lbl = labelRoot.add().move(cg.add(p, [.03, .035, 0])).scale(.25);
            lbl.add(clay.text(lines)).color(pinned ? 1 : .9, pinned ? .4 : .9, pinned ? .4 : .2);
         }
      }
   });
}
