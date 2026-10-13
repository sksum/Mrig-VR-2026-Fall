/*
 * Knight Errant sprite renderer — ported from the "Knight Errant · Sprite Studio"
 * standalone HTML page. The original draws a pixel knight procedurally on 72x72
 * canvases; this module wraps that code as an ES module factory so each character
 * instance owns its canvases and palette.
 *
 * Port notes:
 *  - Palette (ST/SD/OL/OD + hardcoded cape/boot/eye colors) is parameterized so
 *    two knights can share the draw code with different color schemes.
 *  - The output canvas is a 6x integer upscale (432x432, nearest-neighbor) so the
 *    LINEAR texture filtering in clay still reads as crisp pixel art.
 *  - drawFrame() only redraws when the quantized time, animation, or flip changed.
 *  - headPos() returns the last head position (in 432-space, flip applied) so the
 *    scene can anchor a speech bubble above the knight's head.
 */

const log = (...a) => console.log('[knight]', ...a);

// ---------------------------------------------------------------------------
// Palettes. armor = body greys (light->dark ladder), gold = trim/weapon ladder.
// ---------------------------------------------------------------------------

export const PALETTES = {
   steel: {
      name: 'Steel Knight',
      ST: ['#4b4950', '#8b8985', '#c4c2ba', '#ecebe2'],   // armor, front
      SD: ['#37353c', '#5e5c63', '#8b8985', '#a9a7a0'],   // armor, back limbs
      OL: ['#4d3a14', '#8a6a24', '#b8923a', '#dcc070'],   // gold trim
      OD: ['#33270d', '#5f4a1a', '#8a6a24', '#a88a42'],   // gold trim, dark
      capeA: '#b5483a', capeB: '#7a2a24',                 // scarf reds
      bootDark: '#2a2830', bootLight: '#55535a',
      hiltDark: '#3a2a1c',
      eyeWhite: '#e8e0b8', eyeX: '#e0554a', eyeDark: '#1b1920',
   },
   copper: {
      name: 'Copper Knight',
      ST: ['#4a3f38', '#8a7462', '#c0a184', '#e8d4b2'],   // copper armor
      SD: ['#362d27', '#5c4c3f', '#84705c', '#a08a72'],
      OL: ['#134a4a', '#247a78', '#3aa8a2', '#66d2c8'],   // teal trim
      OD: ['#0d3333', '#1a5452', '#247a78', '#3e948e'],
      capeA: '#3a6ab5', capeB: '#24427a',                 // blue scarf
      bootDark: '#2a2630', bootLight: '#55505a',
      hiltDark: '#1c3a3a',
      eyeWhite: '#e8e8d8', eyeX: '#e0554a', eyeDark: '#1b1920',
   },
};

// ---------------------------------------------------------------------------
// Animation metadata (labels + loop periods, from the original GR/INFO tables)
// ---------------------------------------------------------------------------

export const ANIMS = {
   idle:     { label: 'Idle',     period: 2.5  },
   walk:     { label: 'Walk',     period: 0.84 },
   run:      { label: 'Run',      period: 0.48 },
   sneak:    { label: 'Sneak',    period: 1.57 },
   think:    { label: 'Think',    period: 3.14 },
   sit:      { label: 'Sit',      period: 7    },
   sleep:    { label: 'Sleep',    period: 3.9  },
   tired:    { label: 'Tired',    period: 1.57 },
   drink:    { label: 'Drink',    period: 4    },
   attack:   { label: 'Attack',   period: 1.4  },
   block:    { label: 'Block',    period: 1.6  },
   defeated: { label: 'Defeated', period: 5    },
   wave:     { label: 'Wave',     period: 0.52 },
   cheer:    { label: 'Cheer',    period: 0.7  },
   kneel:    { label: 'Kneel',    period: 3.14 },
   inspect:  { label: 'Inspect',  period: 3.14 },
};

const RAW = 72, UPSCALE = 6, TEX = RAW * UPSCALE;   // 72 -> 432

export function createKnight(paletteKey) {
   const P = PALETTES[paletteKey] || PALETTES.steel;
   const { ST, SD, OL, OD } = P;

   const mk = () => { const c = document.createElement('canvas'); c.width = c.height = RAW; return c; };
   const off = mk(), g = off.getContext('2d');
   const sil = mk(), sg = sil.getContext('2d');
   const fin = mk(), fg = fin.getContext('2d');
   const tex = document.createElement('canvas'); tex.width = tex.height = TEX;
   const tg = tex.getContext('2d'); tg.imageSmoothingEnabled = false;

   g.imageSmoothingEnabled = false;

   const sin = Math.sin, cos = Math.cos, PI = Math.PI, abs = Math.abs, max = Math.max, round = Math.round;

   // ------------------------------------------------------------------ helpers (verbatim from source, palette-closured)
   const K = (u, a) => { for (let i = 1; i < a.length; i++) if (u <= a[i][0]) { const [t0, v0] = a[i - 1], [t1, v1] = a[i]; return v0 + (v1 - v0) * (u - t0) / (t1 - t0) } return a[a.length - 1][1] };
   const r = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(round(x), round(y), w, h) };
   function line(a, b, w, c) { const n = max(1, Math.ceil(max(abs(b[0] - a[0]), abs(b[1] - a[1])))); for (let i = 0; i <= n; i++) r(a[0] + (b[0] - a[0]) * i / n - w / 2, a[1] + (b[1] - a[1]) * i / n - w / 2, w, w, c) }
   function disc(cx, cy, R, c) { for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= R * R + R * .6) r(cx + x, cy + y, 1, 1, c) }
   function sl(a, b, w, t) { line([a[0] + 1, a[1] + 1], [b[0] + 1, b[1] + 1], w, t[0]); line(a, b, w, t[1]); line([a[0] - 1, a[1] - 1], [b[0] - 1, b[1] - 1], w - 2, t[2]) }
   function ik(a, b, l, d) { const dx = b[0] - a[0], dy = b[1] - a[1], R = Math.hypot(dx, dy) || 1, L = Math.min(R, 2 * l - .01), x = L / 2, h = Math.sqrt(max(0, l * l - x * x)), ux = dx / R, uy = dy / R; return [a[0] + ux * x - uy * h * d, a[1] + uy * x + ux * h * d] }
   function limb(a, b, l, d, t1, t2, w) { const m = ik(a, b, l, d); sl(a, m, w, t1); sl(m, b, w, t2); r(m[0] - 2, m[1] - 2, 4, 4, t2[1]); r(m[0] - 2, m[1] - 2, 3, 2, t2[3]) }
   const fist = (p) => { r(p[0] - 3, p[1] - 3, 7, 7, OL[0]); r(p[0] - 3, p[1] - 3, 6, 6, OL[1]); r(p[0] - 3, p[1] - 3, 6, 2, OL[3]); r(p[0] - 3, p[1] + 2, 6, 1, OL[0]) };
   const boot = f => { r(f[0] - 3, f[1] - 4, 11, 4, P.bootDark); r(f[0] - 3, f[1] - 4, 11, 1, P.bootLight); r(f[0] + 5, f[1] - 3, 3, 2, P.bootLight) };
   const base = o => Object.assign({ hip: [0, 0], lean: 0, head: [0, 0], hN: [4, 10], hF: [-4, 10], fN: [3, 44], fF: [-3, 44], sw: { a: 2.7 }, sf: null, eye: 'open', cape: 0, fx: [], sc: 0, rot: 0, prop: 0, item: 0 }, o);

   // ------------------------------------------------------------------ draw (verbatim, palette-closured)
   function draw(p, T) {
      g.clearRect(0, 0, RAW, RAW); g.save();
      if (p.rot) { g.translate(36, 66 - 7 * abs(sin(p.rot))); g.rotate(p.rot); g.translate(-36, -66) }
      const Z = 1.5, P2 = a => [a[0] * Z, a[1] * Z];
      const hip = [24 + p.hip[0], 30 + p.hip[1]], sh = [hip[0] + p.lean, hip[1] - 11], hd = [sh[0] + 1 + p.head[0], sh[1] - 6 + p.head[1]];
      const H = P2(hip), Sh = P2(sh), Hd = P2(hd), Hp = [H[0], H[1] + 2], FN = P2([hip[0] + p.fN[0], p.fN[1]]), FF = P2([hip[0] + p.fF[0], p.fF[1]]), HN = P2([sh[0] + p.hN[0], sh[1] + p.hN[1]]), HF = P2([sh[0] + p.hF[0], sh[1] + p.hF[1]]);
      const w = p.cape;
      for (let i = 0; i < 7; i++) { const x = Sh[0] - 5 - i * (3 + w * .4), y = Sh[1] - 1 + i * .8 + sin(T * 9 - i * .9) * (.8 + i * .35) * (.6 + w * .15); r(x, y, 4, 3, P.capeA); r(x, y + 2, 4, 1, P.capeB) }
      if (p.prop) { r(H[0] - 14, H[1] + 3, 28, 5, '#8a5a2b'); r(H[0] - 14, H[1] + 3, 28, 1, '#a87238'); r(H[0] - 14, H[1] + 3, 3, 5, '#c58d4e'); r(H[0] - 13, H[1] + 5, 1, 1, '#5e3a18'); r(H[0] + 8, H[1] + 7, 6, 1, '#5e3a18') }
      if (!p.sf) { disc(Sh[0] - 13, Sh[1] + 9, 7, OL[2]); disc(Sh[0] - 13, Sh[1] + 9, 5, '#55535a'); disc(Sh[0] - 13, Sh[1] + 9, 2, OL[3]) }
      limb(Sh, HF, 9, 1, OD, SD, 4); fist(HF);
      limb(Hp, FF, 12, -1, SD, SD, 5); boot(FF);
      for (let y = Sh[1] - 1; y <= H[1]; y++) { const s = (y - Sh[1]) / max(1, H[1] - Sh[1]), cx = Sh[0] + (H[0] - Sh[0]) * s, wd = round(15 - 5 * s), x0 = round(cx - wd / 2); r(x0, y, wd, 1, ST[1]); r(x0, y, 3, 1, ST[0]); r(x0 + wd - 3, y, 2, 1, ST[2]); if ((y - Sh[1]) % 6 == 5) r(x0, y, wd, 1, ST[0]) }
      for (let i = 0; i < 7; i++) { r(H[0] - 7 + i * .15 * w, H[1] + i, 13, 1, i == 6 ? OL[3] : OL[1]); r(H[0] - 7 + i * .15 * w, H[1] + i, 3, 1, OL[0]) }
      r(H[0] - 7, H[1] - 2, 14, 3, '#2a2420'); r(H[0] + 1, H[1] - 2, 4, 3, OL[3]);
      limb(Hp, FN, 12, -1, ST, ST, 5); boot(FN);
      disc(Sh[0], Sh[1] + 1, 6, ST[1]); disc(Sh[0] - 1, Sh[1], 4, ST[2]); r(Sh[0] - 3, Sh[1] - 3, 3, 1, ST[3]); r(Sh[0] - 6, Sh[1] + 5, 12, 1, OL[2]);
      r(Sh[0] - 6, Sh[1] - 4, 12, 3, P.capeA); r(Sh[0] - 6, Sh[1] - 2, 12, 1, P.capeB);
      const hx = Hd[0], hy = Hd[1];
      [8, 11, 13, 13, 13, 13, 13, 13, 12, 12, 11, 10].forEach((wd, j) => { const x0 = round(hx - 7 + (13 - wd) / 2), y = hy - 7 + j; r(x0, y, wd, 1, ST[1]); r(x0, y, 3, 1, ST[0]); r(x0 + wd - 3, y, 3, 1, ST[2]); if (j < 2) r(x0 + 2, y, wd - 4, 1, ST[3]) });
      r(hx - 6, hy + 5, 12, 3, ST[0]); r(hx - 6, hy + 5, 12, 1, ST[1]); r(hx - 6, hy + 7, 12, 1, OL[1]);
      const e = p.eye, D = P.eyeDark;
      if (e === 'closed') r(hx, hy - 1, 6, 1, D);
      else {
         r(hx, hy - 2, 6, e === 'wide' ? 4 : 3, D); if (e === 'open') r(hx + 3, hy - 1, 2, 1, P.eyeWhite); if (e === 'wide') r(hx + 3, hy - 1, 2, 2, P.eyeWhite);
         if (e === 'x') [[0, -2], [2, -2], [1, -1], [0, 0], [2, 0]].forEach(q => r(hx + q[0] + 1, hy + q[1], 1, 1, P.eyeX))
      }
      limb(Sh, HN, 9, 1, OL, ST, 4); fist(HN);
      if (p.item) { r(HN[0], HN[1] - 6, 4, 8, '#c24f86'); r(HN[0], HN[1] - 8, 4, 2, '#8a5a2b'); r(HN[0] + 1, HN[1] - 5, 1, 3, '#f0a0c8') }
      if (p.sw) { const a = p.sw.a, dx = sin(a), dy = -cos(a), px = cos(a), py = sin(a); let L = 22; if (HN[1] + dy * L > 66) L = (66 - HN[1]) / dy; const E = [HN[0] + dx * L, HN[1] + dy * L]; line([HN[0] + px * 1.5, HN[1] + py * 1.5], [E[0] + px * 1.5, E[1] + py * 1.5], 1, '#9d9575'); line(HN, E, 3, '#d9d2b4'); line([HN[0] - px, HN[1] - py], [E[0] - px, E[1] - py], 1, '#f4efdc'); line([HN[0] + px * 5, HN[1] + py * 5], [HN[0] - px * 5, HN[1] - py * 5], 2, OL[2]); line(HN, [HN[0] - dx * 5, HN[1] - dy * 5], 2, P.hiltDark); r(HN[0] - dx * 7 - 1, HN[1] - dy * 7 - 1, 3, 3, OL[3]) }
      if (p.sf) { const x = Sh[0] + p.sf[0] * Z, y = Sh[1] + p.sf[1] * Z; disc(x, y, 9, OL[2]); disc(x, y, 7, ST[1]); disc(x - 1, y - 1, 5, ST[2]); r(x, y - 7, 1, 15, OL[1]); r(x - 7, y, 15, 1, OL[1]); disc(x, y, 2, OL[3]) }
      g.restore();
      const R = p.rot, dx = hd[0] * Z - 36, dy = hd[1] * Z - 66;
      return [(36 + dx * cos(R) - dy * sin(R)), (66 - 7 * abs(sin(R)) + dx * sin(R) + dy * cos(R))];
   }

   // composite + outline pass (verbatim)
   function render(p, T) {
      const hs = draw(p, T);
      sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, RAW, RAW); sg.drawImage(off, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#14121a'; sg.fillRect(0, 0, RAW, RAW);
      fg.clearRect(0, 0, RAW, RAW); [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(o => fg.drawImage(sil, o[0], o[1])); fg.drawImage(off, 0, 0);
      return hs;
   }

   // ------------------------------------------------------------------ animations (verbatim from source P dict)
   const POSES = {
      idle: t => { const b = sin(t * 2.5) > 0 ? 0 : 1; return { head: [0, b], sw: { a: 2.7 }, cape: b } },
      walk: t => { const ph = t * 7.5, s = sin(ph), c = cos(ph); return { hip: [0, abs(s) > .8 ? 1 : 0], lean: 1, fN: [7 * s, 44 - 3.5 * max(0, c)], fF: [-7 * s, 44 - 3.5 * max(0, -c)], hN: [2 - 4 * s, 10], hF: [-2 + 4 * s, 10], sw: { a: 2.5 + .2 * s }, cape: 1.5, sc: 50 } },
      run: t => { const ph = t * 13, s = sin(ph), c = cos(ph); return { hip: [0, round(-abs(c) * 2) + 1], lean: 4, head: [1, 0], fN: [8 * s, 44 - 6 * max(0, c)], fF: [-8 * s, 44 - 6 * max(0, -c)], hN: [3 - 8 * s, 5], hF: [-3 + 8 * s, 5], sw: { a: 1.9 }, cape: 6, sc: 140, eye: 'wide' } },
      sneak: t => { const ph = t * 4, s = sin(ph), c = cos(ph); return { hip: [2, 6], lean: 3, head: [2, 1], fN: [5 * s + 1, 44 - 2 * max(0, c)], fF: [-5 * s + 1, 44 - 2 * max(0, -c)], hN: [4, 7], hF: [1, 8], sw: { a: 2.2 }, cape: 1, sc: 22 } },
      think: t => { const b = sin(t * 2) > 0 ? 0 : 1; return { head: [1, 1 + b], hN: [5, -3], hF: [3, 7], fN: [3, 44 - (sin(t * 6) > .6 ? 2 : 0)], sw: 0, fx: ['think'] } },
      sit: t => ({ hip: [0, 9], prop: 1, fN: [9, 44], fF: [7, 44], hN: [8, 9], hF: [5, 9], sw: 0, head: [round(sin(t * .9) * 1.5), sin(t * 2.5) > 0 ? 0 : 1] }),
      sleep: t => { const b = sin(t * 1.6) > 0 ? 0 : 1; return { hip: [0, 9], prop: 1, lean: 3 + b, head: [3, 3 + b], fN: [9, 44], fF: [7, 44], hN: [8, 9], hF: [5, 9], sw: 0, eye: 'closed', fx: ['zzz'] } },
      tired: t => { const b = sin(t * 4) > 0 ? 1 : 0; return { hip: [0, 2 + b], lean: 3 + b, head: [2, 3], fN: [3, 44], fF: [-3, 44], hN: [3, 13], hF: [-2, 13], sw: { a: 2.4 }, eye: 'closed', fx: ['sweat'] } },
      attack: t => { const u = (t % 1.4) / 1.4, l = K(u, [[0, 0], [.4, -1], [.5, -1], [.62, 4], [.85, 4], [1, 0]]); return { hip: [l, 3], lean: l * .7, hN: [K(u, [[0, 4], [.35, 0], [.5, 0], [.62, 10], [.8, 9], [1, 4]]), K(u, [[0, 10], [.35, -8], [.5, -8], [.62, 4], [.8, 6], [1, 10]])], hF: [-5, 8], fN: [7 - l, 44], fF: [-6 - l, 44], sw: { a: K(u, [[0, .3], [.35, -1.1], [.5, -1.1], [.62, 2.1], [.8, 2.1], [1, .3]]) }, cape: u > .5 && u < .8 ? -2 : 2, eye: 'wide' } },
      block: t => { const h = (t % 1.6) < .2; return { hip: [h ? -1 : 0, 3], lean: -1, head: [h ? -1 : 0, 0], hN: [6, 3], hF: [-3, 9], fN: [5, 44], fF: [-5, 44], sw: 0, sf: [6, 2], fx: h ? ['spark'] : [], eye: 'wide' } },
      wave: t => ({ hN: [5 + 3 * sin(t * 12), -9], head: [0, -1], sw: 0, fx: ['sparkle'], cape: 1 }),
      cheer: t => { const y = round(-7 * abs(sin(t * 4.5))); return { hip: [0, y], fN: [3, 44 + y * .5], fF: [-3, 44 + y * .5], hN: [5, -11], hF: [-4, -11], sw: { a: .15 }, head: [0, -1], eye: 'wide', cape: -y * .5, fx: ['sparkle'] } },
      kneel: t => ({ hip: [0, 7], fN: [-9, 43], fF: [8, 44], hN: [6, 8], hF: [5, 8], sw: { a: PI }, head: [3, 3], eye: 'closed', fx: sin(t * 2) > 0 ? ['sparkle'] : [] }),
      drink: t => { const u = (t % 4) / 4, k = K(u, [[0, 0], [.25, 1], [.7, 1], [.85, 0], [1, 0]]); return { hN: [4 + k, 10 - 15 * k], head: [0, -k], sw: 0, item: 1, eye: k > .9 ? 'closed' : 'open', fx: u > .85 ? ['sparkle'] : [] } },
      inspect: t => { const u = (sin(t * 2) + 1) / 2; return { hN: [8, -3], hF: [8 + 2 * u, -3 - 9 * u], head: [2, 1], sw: { a: .35 }, fx: u > .8 ? ['sparkle'] : [] } },
      defeated: t => { const u = t % 5, sx = u < 1.2 ? round(sin(t * 8)) : 0; return { hip: [sx, 0], head: [sx, 0], rot: K(u, [[0, 0], [1.2, 0], [1.55, -1.5], [3.6, -1.5], [4.1, 0], [5, 0]]), eye: u > 1.5 && u < 4 ? 'x' : 'open', hN: [2, 12], hF: [-2, 12], sw: { a: 2.6 }, fx: (u < 1.2 || (u > 1.7 && u < 3.6)) ? ['dizzy'] : [] } },
   };

   // fx effects (subset of the source fxDraw, drawn onto the 432 texture canvas)
   function fxDraw(list, hx, hy, t, d) {
      tg.textAlign = 'center';
      list.forEach(f => {
         const x = hx, y = hy;
         if (f === 'zzz') { for (let i = 0; i < 3; i++) { const ph = (t * .5 + i / 3) % 1; tg.globalAlpha = 1 - ph; tg.fillStyle = '#cfe0ff'; tg.font = 'bold ' + (14 + ph * 20) + 'px monospace'; tg.fillText('Z', x + (24 + ph * 34) * d, y - 10 - ph * 70) } tg.globalAlpha = 1 }
         if (f === 'sweat') { tg.fillStyle = '#7fcbff'; for (let i = 0; i < 2; i++) { const ph = (t * 1.5 + i * .5) % 1; tg.globalAlpha = 1 - ph * ph; tg.fillRect(x - (38 + i * 14) * d, y - 20 + ph * 40 + i * 8, 6, 10) } tg.globalAlpha = 1 }
         if (f === 'sparkle' || f === 'spark') { tg.fillStyle = f === 'spark' ? '#fff' : '#ffe27a'; for (let i = 0; i < 4; i++) { const a = t * 2 + i * PI / 2, px = x + (f === 'spark' ? 60 * d : 0) + cos(a) * 46, py = y + sin(a) * 34 - 8, s = (sin(t * 9 + i * 2) > 0) ? 5 : 3; tg.fillRect(px - s, py - 1, s * 2, 2); tg.fillRect(px - 1, py - s, 2, s * 2) } }
         if (f === 'dizzy') { tg.fillStyle = '#ffd23f'; for (let i = 0; i < 3; i++) { const a = t * 4 + i * 2.1, px = x + cos(a) * 34, py = y - 48 + sin(a) * 9; tg.fillRect(px - 5, py - 1, 10, 3); tg.fillRect(px - 1, py - 5, 3, 10) } }
      });
   }

   // ------------------------------------------------------------------ public API
   let lastKey = null, lastHead = [36, 10];

   function drawFrame(anim, t, opts = {}) {
      const flip = !!opts.flip;
      const pose = POSES[anim] ? anim : 'idle';
      const tq = Math.floor(t * 10) / 10;
      const key = pose + '|' + tq + '|' + flip;
      if (key === lastKey) return;                      // nothing changed — skip redraw
      lastKey = key;

      const p = base(POSES[pose](tq));
      let hs = render(p, tq);                           // head pos in 72-space

      // composite to 432 texture canvas with integer upscale + optional flip
      tg.clearRect(0, 0, TEX, TEX);
      tg.save();
      if (flip) { tg.translate(TEX, 0); tg.scale(-1, 1); hs = [RAW - hs[0], hs[1]] }
      tg.drawImage(fin, 0, 0, TEX, TEX);
      tg.restore();

      // fx effects in 432-space (scaled head pos)
      const d = flip ? -1 : 1;
      if (p.fx && p.fx.length) fxDraw(p.fx, hs[0] * UPSCALE, hs[1] * UPSCALE, tq, d);

      lastHead = [hs[0] * UPSCALE, hs[1] * UPSCALE];     // texture-space head pos
   }

   const headPos = () => ({ x: lastHead[0], y: lastHead[1] });

   log('created knight, palette =', paletteKey);
   return { canvas: tex, drawFrame, headPos, PALETTE: P };
}
