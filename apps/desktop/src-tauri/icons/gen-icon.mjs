// Generates a 1024x1024 source PNG for `tauri icon` — the Ateam "A" mark:
// a delta (triangle) outline with a crossbar, in Ateam blue on the dark
// background. Same design concept as before, beautified: rounded, even-width
// strokes rendered from signed-distance fields, a vertical blue gradient on
// the mark, a soft outer glow, and 4x4 supersampled anti-aliasing.
// Pure Node (built-in zlib), no deps, no canvas.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const S = 1024;
const SS = 4; // supersampling factor per axis (16 samples/pixel)

// --- palette ---------------------------------------------------------------
const BG_TOP = [0x10, 0x15, 0x1f]; // subtle lift at the top
const BG_BOT = [0x09, 0x0b, 0x10]; // deeper at the bottom
const GLOW = [0x5b, 0x9b, 0xd5]; // Ateam blue (halo + radial backlight)
const A_TOP = [0x8f, 0xc6, 0xf2]; // light blue at the apex
const A_BOT = [0x46, 0x84, 0xc4]; // deeper blue at the base

// --- geometry (fractions of S) --------------------------------------------
const apex = [0.5 * S, 0.16 * S];
const bl = [0.17 * S, 0.85 * S];
const br = [0.83 * S, 0.85 * S];

// crossbar sits on the two leg centerlines
const cbY = 0.635 * S;
const tLeg = (cbY - apex[1]) / (bl[1] - apex[1]);
const cbL = [apex[0] + (bl[0] - apex[0]) * tLeg, cbY];
const cbR = [apex[0] + (br[0] - apex[0]) * tLeg, cbY];

const HW = 0.052 * S; // outline half-width
const HWC = 0.046 * S; // crossbar half-width
const GLOW_W = 0.06 * S; // halo falloff distance
const GLOW_STR = 0.4; // halo strength

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function sdSeg(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}

function background(fx, fy) {
  const vt = fy / S; // 0 top → 1 bottom
  const base = mix(BG_TOP, BG_BOT, vt);
  // soft radial backlight behind the mark
  const dx = (fx - 0.5 * S) / S;
  const dy = (fy - 0.52 * S) / S;
  const r = Math.sqrt(dx * dx + dy * dy);
  const glow = clamp(1 - r / 0.55, 0, 1);
  const lift = glow * glow * 0.1;
  return [
    lerp(base[0], GLOW[0], lift),
    lerp(base[1], GLOW[1], lift),
    lerp(base[2], GLOW[2], lift),
  ];
}

function sample(fx, fy) {
  const bg = background(fx, fy);

  // distance to the mark: triangle outline (3 edges) + crossbar
  const dOutline = Math.min(
    sdSeg(fx, fy, apex[0], apex[1], bl[0], bl[1]),
    sdSeg(fx, fy, bl[0], bl[1], br[0], br[1]),
    sdSeg(fx, fy, br[0], br[1], apex[0], apex[1]),
  );
  const dCross = sdSeg(fx, fy, cbL[0], cbL[1], cbR[0], cbR[1]);

  const outOutline = dOutline - HW;
  const outCross = dCross - HWC;
  const dMark = Math.min(outOutline, outCross); // <0 inside stroke

  if (dMark <= 0) {
    const t = clamp((fy - apex[1]) / (bl[1] - apex[1]), 0, 1);
    return mix(A_TOP, A_BOT, t);
  }
  // outer glow halo
  const g = clamp(1 - dMark / GLOW_W, 0, 1);
  const strength = g * g * GLOW_STR;
  return mix(bg, GLOW, strength);
}

const raw = Buffer.alloc(S * (S * 4 + 1));
let o = 0;
const inv = 1 / (SS * SS);
for (let y = 0; y < S; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += c[0];
        g += c[1];
        b += c[2];
      }
    }
    raw[o++] = Math.round(clamp(r * inv, 0, 255));
    raw[o++] = Math.round(clamp(g * inv, 0, 255));
    raw[o++] = Math.round(clamp(b * inv, 0, 255));
    raw[o++] = 0xff;
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td), 0);
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(new URL('./source.png', import.meta.url), png);
process.stdout.write(`wrote source.png (${png.length} bytes, ${S}x${S})\n`);
