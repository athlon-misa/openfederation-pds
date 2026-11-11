// Fig: how a pseudonym is made and revealed, drawn as a bench with a blind-stamping press.
// Build: node docs/explainers/pseudonyms/build.mjs [--light]
// Needs the anatomy kit (default ~/.claude/skills/anatomy, or set ANATOMY_KIT).
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = process.env.ANATOMY_KIT ?? join(homedir(), ".claude/skills/anatomy");
const k = await import(pathToFileURL(join(KIT, "kit/iso-kit.mjs")).href);
const { kitScript } = await import(pathToFileURL(join(KIT, "scripts/inline-kit.mjs")).href);

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";

const WIDTH = 640;
const HEIGHT = 400;

// The model. Numbers the figure shows come from here.
const TOKENS_PER_EPOCH = 20; // PSEUDONYM_TOKENS_PER_EPOCH
const KEY_TEETH = 12; // one tooth per word of the BIP-39 phrase

// World layout, about 1 px of the real thing per unit. z = 0 is the plate's top.
const PLATE = { x: -160, y: -60, w: 320, d: 120, r: 8 };
const PLATE_H = 12;
const FOOT_H = 5;
const SEAM_X = -40; // device half | server half

const DESK = -100; // carriage stop under the lift (your device)
const PRESS = 40; // carriage stop under the press (the PDS)
const STAMP = [3, 0]; // where the die lands, carriage-local
const CART_TOP = 8;
const SLIP_TOP = 9.2;
const HOOD_TOP = 19;
const LIFT_UP = 34;

const LIFT_X = DESK - 10;
const POST_Y = 32;
const POST_TOP = 78;

const HEAD = [PRESS + STAMP[0], 0];
const DIE_UP = 32; // die bottom at rest
const RAM_STAMP = HOOD_TOP - DIE_UP; // ram offset that lands on the hood
const RAM_PUNCH = SLIP_TOP - DIE_UP; // ram offset that lands on the bare slip
const DIAL = [HEAD[0], -46.5];
const DIAL_R = 7;
const DIAL_TOP = 100;
const DIAL_FROM = (-150 * Math.PI) / 180;
const DIAL_SPAN = (300 * Math.PI) / 180;

const TOWER = { x: 104, y: -17, w: 48, d: 34, r: 2.5 };
const TOWER_H = 36;
const TAG = { x: 111, y: -12, w: 2.4, d: 24, r: 0.6 };
const TAG_FACE = TAG.x + TAG.w;
const TAG_RISE = 42;
const TAG_TOP = 76;
const SHUTTER_TRAVEL = 10.4;
const KEY_TRAVEL = 11;

const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    [LIFT_X, 0, POST_TOP + 10.5],
    [DIAL[0], DIAL[1] - DIAL_R, DIAL_TOP],
    [TAG.x, TAG.y, TAG_TOP],
  ],
  WIDTH,
  HEIGHT,
  { pad: 26, azimuth: 52 },
);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
const halo = (plan, z, h, blur = 4) => `<path class="iso-halo" d="${k.haloOf(plan, z, h, P)}" style="filter:blur(${blur}px)"/>`;
// A closed rectangle on a vertical face: x fixed (+x face) or y fixed (+y face).
const faceRectX = (x, y0, y1, z0, z1) => k.pathOf([at([x, y0, z0]), at([x, y1, z0]), at([x, y1, z1]), at([x, y0, z1])], true);
const faceRectY = (y, x0, x1, z0, z1) => k.pathOf([at([x0, y, z0]), at([x1, y, z0]), at([x1, y, z1]), at([x0, y, z1])], true);

// The owner's "name": three printed rules on the hood's nameplate, matched by the rules behind the tag's window.
const NAME_RULES = [12.5, 8.5, 10.5];

function plate() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(PLATE, 22))) {
    out.push(S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
  }
  // The joint between the device half and the server half runs over the top and down the front face.
  const joint = L(k.lineOnTop([SEAM_X, PLATE.y], [SEAM_X, PLATE.y + PLATE.d], 0, P) + k.segment([SEAM_X, PLATE.y + PLATE.d, 0], [SEAM_X, PLATE.y + PLATE.d, -PLATE_H], P), { tone: "lo" });
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid", inner: joint }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "faint" }));
  const screws = k.corners(PLATE, 10);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  // Bolts either side of the joint.
  out.push(D([-44, 44].flatMap((y) => [at([SEAM_X - 4, y, 0]), at([SEAM_X + 4, y, 0])]), { size: 0.45 }));
  // Ruler along the front edge.
  const strip = { x: -140, y: 46, w: 150, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 4, 5, strip.y + 0.8, 0.6, [2, 3.6], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 2, strip.y + 3.5, 0.6]), at([strip.x + strip.w - 2, strip.y + 3.5, 0.6])], { size: 0.45 }));
  // Label plate.
  const label = { x: 60, y: 30, w: 36, d: 17, r: 1.5 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 4), { tone: "lo", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(label, 1.6), 0.8, P, 4), { tone: "faint" }));
  out.push(
    L([22, 15, 18].map((len, i) => k.lineOnTop([label.x + 5, label.y + 5 + i * 3.5], [label.x + 5 + len, label.y + 5 + i * 3.5], 0.8, P)).join(""), { tone: "lo", free: true }),
  );
  out.push(D([at([label.x + 3, label.y + 3, 0.8]), at([label.x + label.w - 3, label.y + label.d - 3, 0.8])], { size: 0.4 }));
  return out.join("");
}

function rails() {
  const out = [];
  for (const y of [-15, 10]) {
    out.push(S(k.slabOf({ x: -138, y, w: 226, d: 5, r: 1 }, 0, 3, P, 3, 0.4), { tone: "mid" }));
    out.push(D([-132, -60, 10, 82].map((x) => at([x, y + 2.5, 3])), { size: 0.4 }));
  }
  for (const x of [-143, 88]) {
    out.push(S(k.slabOf({ x, y: -19, w: 5, d: 38, r: 1.2 }, 0, 7, P, 3, 0.5), { tone: "mid" }));
    out.push(D([at([x + 2.5, -15, 7]), at([x + 2.5, 15, 7])], { size: 0.45 }));
  }
  return out.join("");
}

// The PDS: a column press. Everything behind the carriage.
function pressBack() {
  const out = [];
  const base = { x: 30, y: -58, w: 26, d: 20, r: 2 };
  out.push(S(k.slabOf(base, 0, 8, P, 4, 0.8), { tone: "mid" }));
  out.push(D(k.corners(base, 3).map(([x, y]) => at([x, y, 8])), { size: 0.45 }));
  const column = { x: 36, y: -53, w: 14, d: 13, r: 2 };
  out.push(S(k.slabOf(column, 8, 84, P, 4, 0.6), { tone: "mid", inner: L([30, 60].map((z) => k.sideSeam(column, z, P, 4)).join(""), { tone: "faint" }) }));
  const arm = { x: 38, y: -41, w: 10, d: 41, r: 1.5 };
  out.push(S(k.slabOf(arm, 70, 12, P, 3, 0.5), { tone: "mid" }));
  out.push(D([at([43, -36, 82]), at([43, -20, 82])], { size: 0.45 }));
  const cap = { x: 34, y: -55, w: 18, d: 17, r: 2 };
  out.push(S(k.slabOf(cap, 92, 3, P, 4, 0.5), { tone: "mid" }));
  out.push(D(k.corners(cap, 2).map(([x, y]) => at([x, y, 95])), { size: 0.4 }));
  // Tokens-left dial: one tick per token this month.
  const [x, y] = DIAL;
  out.push(S(k.cylinder(x, y, DIAL_R, 95, DIAL_TOP - 95, P, 48, 0.6), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(x, y, DIAL_R, DIAL_TOP - 2.4, DIAL_TOP, 48, P, 0.3), { tone: "lo" }));
  out.push(L(k.ring(x, y, DIAL_R - 1.4, DIAL_TOP, P, 48), { tone: "lo" }));
  const ticks = k.radialTicks(x, y, DIAL_R - 1.8, TOKENS_PER_EPOCH, 5, DIAL_TOP, [0.9, 1.9], P, DIAL_FROM, DIAL_SPAN);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(L(k.ring(x, y, 1, DIAL_TOP, P, 12), { tone: "mid" }));
  return out.join("");
}

const needleAt = (left) => {
  const angle = DIAL_FROM + (left / 20) * DIAL_SPAN;
  const [x, y] = DIAL;
  return k.lineOnTop([x - Math.sin(angle) * 1, y + Math.cos(angle) * 1], [x + Math.sin(angle) * (DIAL_R - 2.2), y - Math.cos(angle) * (DIAL_R - 2.2)], DIAL_TOP + 0.1, P);
};

// Your device: a lift on two posts that lowers the envelope onto the token and takes it off again.
const collar = (y) => S(k.cylinder(LIFT_X, y, 5, 0, 4, P, 28), { tone: "mid" });
const post = (y) => S(k.cylinder(LIFT_X, y, 2.4, 4, POST_TOP - 4, P, 20), { tone: "mid", crease: "none" });
const sleeve = (y) => S(k.cylinder(LIFT_X, y, 4.6, 25, 7, P, 28), { tone: "mid", inner: L(k.sideArc(LIFT_X, y, 4.6, 28.5, P, 20), { tone: "faint" }) });

function crosshead() {
  const out = [];
  const jaw = { x: LIFT_X - 3, y: -3, w: 6, d: 6, r: 1 };
  out.push(S(k.slabOf(jaw, 22.5, 3.5, P, 3), { tone: "mid", crease: "none" }));
  const bar = { x: LIFT_X - 4, y: -28, w: 8, d: 56, r: 1.5 };
  out.push(S(k.slabOf(bar, 26, 5, P, 3, 0.5), { tone: "mid" }));
  out.push(D([at([LIFT_X, -6, 31]), at([LIFT_X, 6, 31])], { size: 0.45 }));
  return out.join("");
}

function liftTop() {
  const out = [];
  const beam = { x: LIFT_X - 4.5, y: -37, w: 9, d: 74, r: 3 };
  out.push(S(k.slabOf(beam, POST_TOP, 6, P, 4, 0.6), { tone: "mid" }));
  out.push(D([at([LIFT_X, -POST_Y, POST_TOP + 6]), at([LIFT_X, POST_Y, POST_TOP + 6])], { size: 0.5 }));
  out.push(L(k.ring(LIFT_X, -POST_Y, 2, POST_TOP + 6, P, 14) + k.ring(LIFT_X, POST_Y, 2, POST_TOP + 6, P, 14), { tone: "lo" }));
  const z = POST_TOP + 6;
  out.push(S(k.cylinder(LIFT_X, 0, 4.5, z, 4.5, P, 32), { tone: "mid" }));
  out.push(L(k.knurl(LIFT_X, 0, 4.5, z, z + 4.5, 30, P), { tone: "lo" }));
  out.push(L(k.lineOnTop([LIFT_X - 4.5, 0], [LIFT_X + 4.5, 0], z + 4.5, P), { tone: "hi" }));
  return out.join("");
}

// The carriage and the token. Built at the desk stop.
function carriage() {
  const plan = { x: DESK - 24, y: -20, w: 48, d: 40, r: 3 };
  const out = [halo(k.insetPlan(plan, 3), 3, 0.1)];
  out.push(S(k.slabOf(plan, 3, CART_TOP - 3, P, 5, 0.6), { tone: "mid" }));
  out.push(D([-18, -6, 6, 18].map((x) => at([DESK + x, plan.y + plan.d - 2.4, CART_TOP])), { size: 0.4, tone: "lo" }));
  for (const [x, y] of byDepth([[DESK - 23, -19], [DESK + 16, -19], [DESK - 23, 12], [DESK + 16, 12]])) {
    const block = { x, y, w: 7, d: 7, r: 1.2 };
    out.push(S(k.slabOf(block, CART_TOP, 3, P, 3, 0.4), { tone: "mid" }));
    out.push(D([at([x + 3.5, y + 3.5, CART_TOP + 3])], { size: 0.45 }));
  }
  // The bed the token lies in.
  out.push(L(k.planOutline({ x: DESK - 13.5, y: -9.5, w: 27, d: 19, r: 1.5 }, CART_TOP, P, 3), { tone: "faint" }));
  // Handle.
  out.push(S(k.slabOf({ x: DESK + 24, y: -2, w: 3, d: 4, r: 1 }, 4, 3, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(DESK + 29, 0, 2.6, 3, 5, P, 20), { tone: "mid" }));
  out.push(L(k.knurl(DESK + 29, 0, 2.6, 3, 8, 18, P), { tone: "lo" }));
  // The token: random bytes, lit.
  const slip = { x: DESK - 12, y: -8, w: 24, d: 16, r: 1 };
  const [sx, sy] = [DESK + STAMP[0], STAMP[1]];
  const seal = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return at([sx + Math.cos(a) * 3.7, sy + Math.sin(a) * 3.7, SLIP_TOP]);
  });
  out.push(
    `<g data-part="slip">${S(k.slabOf(slip, CART_TOP, SLIP_TOP - CART_TOP, P, 2), { tone: "hi", lit: true, crease: "lo" })}` +
      `<g data-part="stamp" opacity="0">${L(k.ring(sx, sy, 4.6, SLIP_TOP, P, 32) + k.ring(sx, sy, 2.7, SLIP_TOP, P, 24), { tone: "mid" })}${D(seal, { size: 0.4, tone: "mid" })}</g>` +
      `<g data-part="hole" opacity="0"><path class="pz-hole" d="${k.ring(sx, sy, 1.7, SLIP_TOP, P, 20)}"/>${L(k.ring(sx, sy, 1.7, SLIP_TOP, P, 20), { tone: "mid" })}</g></g>`,
  );
  return out.join("");
}

// The blinding envelope: a carbon-lined hood with the owner's nameplate on its face.
function hood() {
  const plan = { x: DESK - 15, y: -13, w: 30, d: 26, r: 2 };
  const out = [halo(k.insetPlan(plan, 2), CART_TOP, 0.1, 3)];
  out.push(S(k.slabOf(plan, CART_TOP, HOOD_TOP - CART_TOP, P, 4, 0.8), { tone: "hi", crease: "lo", inner: L(k.sideSeam(plan, CART_TOP + 2, P, 4), { tone: "faint" }) }));
  out.push(L(k.ring(DESK + STAMP[0], STAMP[1], 6.4, HOOD_TOP, P, 40), { tone: "faint" }));
  // Grip knob for the lift's jaw.
  out.push(S(k.cylinder(DESK - 10, 0, 2.6, HOOD_TOP, 3.5, P, 20), { tone: "mid" }));
  out.push(L(k.knurl(DESK - 10, 0, 2.6, HOOD_TOP, HOOD_TOP + 3.5, 16, P), { tone: "lo" }));
  // Nameplate on the front face: this is what the press can see.
  const name = { x: DESK - 6, y: 13, w: 17, d: 0.7, r: 0.3 };
  out.push(S(k.slabOf(name, 11, 6.5, P, 2), { tone: "mid", crease: "none" }));
  const face = name.y + name.d;
  out.push(L(NAME_RULES.map((len, i) => k.segment([name.x + 2, face, 16 - i * 1.9], [name.x + 2 + len, face, 16 - i * 1.9], P)).join(""), { tone: "lo", free: true }));
  out.push(D([at([name.x + 0.9, face, 14.25]), at([name.x + name.w - 0.9, face, 14.25])], { size: 0.35 }));
  return out.join("");
}

function ram() {
  const [x, y] = HEAD;
  const out = [];
  out.push(S(k.cylinder(x, y, 6, DIE_UP, 4, P, 32, 0.5), { tone: "hi", crease: "lo", inner: L(k.sideArc(x, y, 6, DIE_UP + 1.4, P, 24), { tone: "faint" }) }));
  out.push(S(k.cylinder(x, y, 2.6, DIE_UP + 4, 44, P, 20), { tone: "mid", crease: "none" }));
  return out.join("");
}

function pressHead() {
  const [x, y] = HEAD;
  const out = [];
  out.push(S(k.cylinder(x, y, 6, 50, 4, P, 32), { tone: "mid" }));
  out.push(S(k.cylinder(x, y, 9, 54, 32, P, 40, 0.6), { tone: "mid", inner: L([60, 80].map((z) => k.sideArc(x, y, 9, z, P, 32)).join(""), { tone: "faint" }) }));
  out.push(S(k.cylinder(x, y, 6.5, 86, 4, P, 32, 0.4), { tone: "mid" }));
  const bolts = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    return at([x + Math.cos(a) * 7.7, y + Math.sin(a) * 7.7, 86]);
  });
  out.push(D(bolts, { size: 0.4 }));
  out.push(L(k.ring(x, y, 3, 90, P, 20), { tone: "lo" }));
  // Hand lever on the front.
  out.push(S(k.slabOf({ x: x - 1.5, y: 8.5, w: 3, d: 14, r: 1 }, 74, 4, P, 2, 0.3), { tone: "mid" }));
  out.push(S(k.cylinder(x, 24.5, 3, 72, 8, P, 24), { tone: "mid" }));
  out.push(L(k.knurl(x, 24.5, 3, 72, 80, 20, P), { tone: "lo" }));
  return out.join("");
}

// The registry: a tower that raises the new did:plc tag, and a 12-tooth key on a slide.
function towerBody() {
  const out = [halo(TOWER, 0, TOWER_H, 6)];
  out.push(S(k.slabOf(TOWER, 0, TOWER_H, P, 4, 0.8), { tone: "mid", inner: L(k.sideSeam(TOWER, 6, P, 4), { tone: "faint" }) }));
  out.push(D(k.corners(TOWER, 3).map(([x, y]) => at([x, y, TOWER_H])), { size: 0.45 }));
  // Vents on the +x face: closed slots.
  out.push(L([0, 1, 2, 3].map((i) => faceRectX(TOWER.x + TOWER.w, -9 + i * 5.2, -6 + i * 5.2, 12, 26)).join(""), { tone: "lo" }));
  const slot = { x: 110.5, y: -13, w: 4, d: 26, r: 1 };
  out.push(`<path class="pz-hole" d="${k.planOutline(slot, TOWER_H, P, 3)}"/>`);
  out.push(L(k.planOutline(slot, TOWER_H, P, 3), { tone: "lo" }));
  out.push(guide(-15.5));
  return out.join("");
}

const guide = (y) => S(k.slabOf({ x: 109.6, y, w: 6, d: 2.2, r: 0.6 }, TOWER_H, 4, P, 2), { tone: "mid" });

function tag() {
  const out = [];
  out.push(S(k.slabOf(TAG, TAG_TOP - TAG_RISE, TAG_RISE, P, 2), { tone: "hi", crease: "lo" }));
  const x = TAG_FACE;
  // Window holding the commitment: the owner's rules, mixed with the salt, behind a shutter.
  out.push(L(faceRectX(x, -9, -1, 57.6, 68.4), { tone: "lo" }));
  out.push(L(NAME_RULES.map((len, i) => k.segment([x, -8, 66.2 - i * 2.6], [x, -8 + len * 0.55, 66.2 - i * 2.6], P)).join(""), { tone: "lo", free: true }));
  for (const z of [56.4, 68.6]) out.push(S(k.slabOf({ x, y: -10.5, w: 0.9, d: 21.5, r: 0.3 }, z, 1, P, 2), { tone: "mid", crease: "none" }));
  out.push(`<g data-part="shutter">${S(k.slabOf({ x, y: -9.6, w: 0.7, d: 9.2, r: 0.3 }, 57.4, 11.2, P, 2), { tone: "mid" })}${D([at([x + 0.7, -5, 63])], { size: 0.45, tone: "hi" })}</g>`);
  // Lock.
  out.push(S(k.slabOf({ x, y: 3, w: 1.6, d: 6, r: 0.8 }, 44.5, 7, P, 3), { tone: "mid" }));
  out.push(L(faceRectX(x + 1.6, 5.4, 6.6, 46, 50.5), { tone: "lo" }));
  out.push(k.faceTextSvg(k.sideMatrix([x + 0.05, 10], 73, P, "right"), "did:plc", { size: 2.4, tone: "lo" }));
  return out.join("");
}

function keySlide() {
  const out = [];
  out.push(S(k.slabOf({ x: 118, y: 4.5, w: 32, d: 3, r: 0.8 }, TOWER_H, 1.4, P, 2, 0.3), { tone: "lo" }));
  out.push(D([at([120, 6, TOWER_H + 1.4]), at([148, 6, TOWER_H + 1.4])], { size: 0.4 }));
  return out.join("");
}

function key() {
  const out = [];
  out.push(S(k.slabOf({ x: 142, y: 3, w: 7, d: 6, r: 1 }, TOWER_H + 1.4, 6.6, P, 3, 0.4), { tone: "mid" }));
  const blade = { x: 126, y: 5.3, w: 17, d: 1.4, r: 0.3 };
  // Twelve cuts, one per word.
  const cuts = [1.4, 0.6, 1.8, 1.0, 0.4, 1.6, 1.2, 0.8, 1.7, 0.5, 1.3, 0.9];
  cuts.forEach((depth, i) => {
    out.push(S(k.slabOf({ x: 127 + i * 1.15, y: blade.y, w: 1, d: blade.d, r: 0.1 }, 46.5 - depth, depth + 0.2, P, 1), { tone: "hi", crease: "none" }));
  });
  out.push(S(k.slabOf(blade, 46.5, 3, P, 1), { tone: "hi", crease: "lo" }));
  const bow = { x: 143, y: 5.1, w: 4.4, d: 1.8, r: 0.6 };
  out.push(S(k.slabOf(bow, TOWER_H + 8, 9, P, 2), { tone: "hi", crease: "lo", inner: L(k.sideRing([145.2, bow.y + bow.d, 50.5], 1, "y", P, 16), { tone: "lo" }) }));
  return out.join("");
}

// Clip the tag to what stands above the slot's near edge.
const slotEdge = [at([TAG_FACE + 1.1, -400, TOWER_H]), at([TAG_FACE + 1.1, 400, TOWER_H])];
const clip = k.pathOf([slotEdge[0], slotEdge[1], [slotEdge[1][0], slotEdge[1][1] - 2000], [slotEdge[0][0], slotEdge[0][1] - 2000]], true);

const START = { cx: DESK, lift: LIFT_UP, hoodOn: "lift", ram: 0, tag: 0, shutter: 0, key: 0 };
const move = (d) => k.translateAlong(P, d);

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "A bench in two halves. On the left, your device: a lift on two posts holds a carbon-lined hood with your nameplate on it. A carriage on rails carries a lit paper token. On the right, the PDS: a column press with a dial counting 20 tokens a month, and a tower that raises a new did:plc tag with a sealed window and a lock for a 12-tooth key.",
  body: [
    plate(),
    rails(),
    pressBack(),
    `<path data-part="needle" class="iso-line" data-tone="hi" data-free="start" d="${needleAt(TOKENS_PER_EPOCH)}" style="stroke-width:0.9"/>`,
    collar(-POST_Y),
    post(-POST_Y),
    `<g data-part="lift" transform="${move([0, 0, START.lift])}">${sleeve(-POST_Y)}</g>`,
    `<g data-part="carriage">${carriage()}</g>`,
    `<g data-part="hood" transform="${move([0, 0, START.lift])}">${hood()}</g>`,
    `<g data-part="lift" transform="${move([0, 0, START.lift])}">${crosshead()}</g>`,
    collar(POST_Y),
    post(POST_Y),
    `<g data-part="lift" transform="${move([0, 0, START.lift])}">${sleeve(POST_Y)}</g>`,
    liftTop(),
    `<g data-part="ram">${ram()}</g>`,
    pressHead(),
    towerBody(),
    `<clipPath id="pz-slot"><path d="${clip}"/></clipPath><g clip-path="url(#pz-slot)"><g data-part="tag" transform="${move([0, 0, -TAG_RISE])}">${tag()}</g></g>`,
    guide(13.3),
    keySlide(),
    `<g data-part="key">${key()}</g>`,
  ],
});

const STEPS = [
  {
    name: "Seal",
    title: "Seal a blank token",
    text: "Your app picks 32 random bytes and seals them in a blinding envelope. Only your device can take the envelope off again.",
    sees: "Nothing yet. This happens on your device.",
  },
  {
    name: "Stamp",
    title: "The PDS stamps it blind",
    text: "The PDS signs through the envelope. It sees which account is asking and counts its 20 tokens for the month, but it never sees the token inside.",
    sees: "Your account. It can't see the token.",
  },
  {
    name: "Unwrap",
    title: "Unwrap it at home",
    text: "Back on your device the envelope comes off. The stamp went through the carbon: the PDS's signature is now on a token the PDS has never seen.",
    sees: "Nothing. This happens on your device.",
  },
  {
    name: "Spend",
    title: "Spend it for a new identity",
    text: "Later, with no login, the token pays for a new did:plc. The PDS checks its own stamp and keeps only a hash so the token can't be spent twice. The new DID is born with a sealed commitment to your account: sha256(owner + a secret salt).",
    sees: "A valid stamp and a new DID. It can't see whose they are.",
  },
  {
    name: "Reveal",
    title: "Reveal, only if you choose",
    text: "Your 12 words hold the pseudonym's key and the salt. Show them and anyone can recompute the seal, see that it names your account, and check both signatures. Without them the window stays shut.",
    sees: "Only what you choose to show.",
  },
];

const stepper = `<div class="pz-steps" role="group" aria-label="Steps">${STEPS.map((s, i) => `<button type="button" class="pz-step" data-step="${i}" aria-pressed="${i === 0}"><span class="pz-num">${i + 1}</span>${s.name}</button>`).join("")}</div>
<div class="pz-explain" aria-live="polite"><p class="pz-title" data-explain="title">${STEPS[0].title}</p><p data-explain="text">${STEPS[0].text}</p><p class="pz-sees"><span>PDS sees</span> <span data-explain="sees">${STEPS[0].sees}</span></p></div>`;

const CSS = `
.pz-hole{fill:var(--anatomy-shade-0);stroke:none}
.iso[data-theme="light"] .pz-hole{fill:var(--anatomy-lo)}
.iso-stage{cursor:pointer;outline:none}
.iso-stage:focus-visible{box-shadow:0 0 0 1px var(--anatomy-mid)}
.pz-steps{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:18px 0 0}
.pz-step{display:inline-flex;align-items:center;gap:7px;padding:5px 11px 5px 6px;border:0;border-radius:999px;background:transparent;color:var(--anatomy-muted);font:500 12px/1 var(--anatomy-mono);letter-spacing:.04em;box-shadow:0 0 0 1px var(--anatomy-faint);cursor:pointer;transition:color .2s,box-shadow .2s}
.pz-step:hover{color:var(--anatomy-text);box-shadow:0 0 0 1px var(--anatomy-lo)}
.pz-step[aria-pressed="true"]{color:var(--anatomy-strong);box-shadow:0 0 0 1px var(--anatomy-mid)}
.pz-num{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--anatomy-face);color:inherit;font-size:10.5px;box-shadow:0 0 0 1px var(--anatomy-faint)}
.pz-step[aria-pressed="true"] .pz-num{background:var(--anatomy-strong);color:var(--anatomy-card)}
.pz-explain{max-width:520px;margin:14px auto 0;text-align:center;min-height:8.4em}
.pz-explain p{margin:0 0 6px;color:var(--anatomy-text);font-size:13.5px;line-height:1.55}
.pz-explain .pz-title{color:var(--anatomy-strong);font-weight:600;font-size:14px}
.pz-sees{font-family:var(--anatomy-mono);font-size:11.5px!important;color:var(--anatomy-muted)!important}
.pz-sees span:first-child{text-transform:uppercase;letter-spacing:.1em;margin-right:4px}
`;

const DATA = {
  P,
  DESK,
  PRESS,
  LIFT_UP,
  RAM_STAMP,
  RAM_PUNCH,
  TAG_RISE,
  SHUTTER_TRAVEL,
  KEY_TRAVEL,
  DIAL,
  DIAL_R,
  DIAL_TOP,
  DIAL_FROM,
  DIAL_SPAN,
  PER_EPOCH: TOKENS_PER_EPOCH,
  START,
  STEPS,
};

const live = `
const DATA = ${JSON.stringify(DATA)};
const { P, DESK, PRESS, LIFT_UP, RAM_STAMP, RAM_PUNCH, TAG_RISE, SHUTTER_TRAVEL, KEY_TRAVEL, DIAL, DIAL_R, DIAL_TOP, DIAL_FROM, DIAL_SPAN, PER_EPOCH, STEPS } = DATA;
const stage = document.querySelector(".iso-stage");
const svg = stage.querySelector("svg");
const q = (name) => [...svg.querySelectorAll('[data-part="' + name + '"]')];
const parts = { lift: q("lift"), carriage: q("carriage")[0], hood: q("hood")[0], ram: q("ram")[0], tag: q("tag")[0], shutter: q("shutter")[0], key: q("key")[0], needle: q("needle")[0], slip: q("slip")[0], stamp: q("stamp")[0], hole: q("hole")[0] };
const readout = document.querySelector("[data-readout]");
const buttons = [...document.querySelectorAll(".pz-step")];
const explain = { title: document.querySelector('[data-explain="title"]'), text: document.querySelector('[data-explain="text"]'), sees: document.querySelector('[data-explain="sees"]') };
const still = matchMedia("(prefers-reduced-motion: reduce)");

const s = { ...DATA.START, stamp: 0, hole: 0, slip: 1, tokens: PER_EPOCH, dial: PER_EPOCH, spent: 0 };
const needleAt = ${needleAt.toString().replace("k.lineOnTop", "lineOnTop")};

// Each step is a list of operations: tweens of state values, instant sets, waits and events.
const tween = (to, dur, ease = "inOut") => ({ to, dur, ease });
const STEP_OPS = [
  [tween({ lift: 0 }, 1.3), { set: { hoodOn: "cart" } }, { wait: 0.25 }, tween({ lift: LIFT_UP }, 1.0)],
  [tween({ cx: PRESS }, 1.7), { wait: 0.2 }, tween({ ram: RAM_STAMP }, 0.45, "in"), { event: "stamp" }, { wait: 0.35 }, tween({ ram: 0 }, 0.7)],
  [tween({ cx: DESK }, 1.7), tween({ lift: 0 }, 1.0), { set: { hoodOn: "lift" } }, { wait: 0.2 }, tween({ lift: LIFT_UP }, 1.2)],
  [tween({ cx: PRESS }, 1.7), { wait: 0.2 }, tween({ ram: RAM_PUNCH }, 0.5, "in"), { event: "punch" }, { wait: 0.3 }, tween({ ram: 0 }, 0.7), tween({ tag: 1 }, 1.4)],
  [tween({ key: 1 }, 1.1), { wait: 0.15 }, tween({ shutter: 1 }, 1.0)],
];
// From the end of Reveal back to the start of Seal: put the key back, lower the tag, take a fresh token.
const RESET = [tween({ shutter: 0 }, 0.6), tween({ key: 0 }, 0.6), tween({ tag: 0 }, 1.0), tween({ slip: 0 }, 0.35), { event: "fresh" }, tween({ cx: DESK }, 1.5), tween({ slip: 1 }, 0.45)];

const ease = { inOut: (t) => t * t * (3 - 2 * t), in: (t) => t * t * t };
let queue = [], op = null, opT = 0, from = null;
let done = -1; // last step whose operations have all run
let playing = -1; // step being shown
let dwell = 0, touring = !still.matches, idleTimer = 0, frame = 0, last = 0, visible = false;

function begin(next) {
  op = next; opT = 0; from = {};
  if (op.to) for (const key in op.to) from[key] = s[key];
}
function finish() {
  if (op.set) Object.assign(s, op.set);
  if (op.to) Object.assign(s, op.to);
  if (op.event === "stamp") { s.stamp = 1; s.tokens = Math.max(0, s.tokens - 1); }
  if (op.event === "punch") { s.hole = 1; s.spent += 1; }
  if (op.event === "fresh") { s.stamp = 0; s.hole = 0; if (s.tokens === 0) s.tokens = PER_EPOCH; }
  if (op.mark !== undefined) done = op.mark;
  if (op.show !== undefined) show(op.show);
  op = null;
}
// Skipped steps run five times faster, so a jump still shows the machine doing the work.
function advance(dt) {
  let budget = dt;
  while (budget > 0) {
    if (!op) { if (!queue.length) return false; begin(queue.shift()); }
    const length = op.dur ?? op.wait ?? 0;
    const rate = op.fast ? 5 : 1;
    const step = Math.min(budget * rate, length - opT);
    opT += step; budget -= step / rate;
    if (op.to && length > 0) {
      const t = ease[op.ease](Math.min(1, opT / length));
      for (const key in op.to) s[key] = from[key] + (op.to[key] - from[key]) * t;
    }
    if (opT >= length - 1e-9) finish();
    else return true;
  }
  return true;
}
const copies = (list, fast = false) => list.map((o) => ({ ...o, fast }));
const opsFor = (index, fast) => [...copies(STEP_OPS[index], fast), { mark: index }];
// Queue whatever takes the machine from its present state through step 'target'.
function goTo(target) {
  const busy = Boolean(op || queue.length);
  const natural = !busy && target === (done + 1) % STEPS.length;
  if (op) op.fast = true;
  const plan = copies(queue, true);
  let at = busy ? playing : done;
  if (target <= at) { plan.push(...copies(RESET, !natural)); at = -1; }
  for (let i = at + 1; i < target; i++) plan.push(...opsFor(i, true));
  plan.push({ show: target }, ...opsFor(target));
  queue = plan;
  playing = target;
  dwell = 0;
  run();
}
function show(index) {
  const step = STEPS[index];
  buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
  explain.title.textContent = step.title;
  explain.text.textContent = step.text;
  explain.sees.textContent = step.sees;
}

function draw() {
  const hx = s.hoodOn === "cart" ? s.cx - DESK : 0;
  const hz = s.hoodOn === "lift" ? s.lift : 0;
  parts.lift.forEach((el) => el.setAttribute("transform", translateAlong(P, [0, 0, s.lift])));
  parts.carriage.setAttribute("transform", translateAlong(P, [s.cx - DESK, 0, 0]));
  parts.hood.setAttribute("transform", translateAlong(P, [hx, 0, hz]));
  parts.ram.setAttribute("transform", translateAlong(P, [0, 0, s.ram]));
  parts.tag.setAttribute("transform", translateAlong(P, [0, 0, -TAG_RISE * (1 - s.tag)]));
  parts.shutter.setAttribute("transform", translateAlong(P, [0, SHUTTER_TRAVEL * s.shutter, 0]));
  parts.key.setAttribute("transform", translateAlong(P, [-KEY_TRAVEL * s.key, 0, 0]));
  parts.needle.setAttribute("d", needleAt(s.dial));
  parts.slip.setAttribute("opacity", s.slip.toFixed(3));
  parts.stamp.setAttribute("opacity", String(s.stamp));
  parts.hole.setAttribute("opacity", String(s.hole));
  const text = "tokens left " + s.tokens + " of " + PER_EPOCH + " · spent " + s.spent;
  if (readout.textContent !== text) readout.textContent = text;
}
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  const busy = advance(still.matches ? 1e6 : dt);
  const target = s.tokens;
  s.dial = still.matches ? target : s.dial + (target - s.dial) * (1 - Math.exp(-dt / 0.25));
  if (Math.abs(target - s.dial) < 0.002) s.dial = target;
  if (!busy && touring) {
    dwell += dt;
    if (dwell > 2.4) goTo((playing + 1) % STEPS.length);
  }
  draw();
  const settled = !busy && !touring && s.dial === target;
  frame = visible && !settled ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
const hold = () => {
  touring = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { touring = !still.matches; dwell = 0; run(); }, 9000);
};
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
buttons.forEach((b) => b.addEventListener("click", () => { hold(); goTo(Number(b.dataset.step)); }));
stage.addEventListener("click", () => { hold(); goTo((playing + 1) % STEPS.length); });
document.addEventListener("keydown", (event) => {
  if (!stage.closest(".iso-figure").contains(document.activeElement) && document.activeElement !== document.body) return;
  let to = null;
  if (event.key === "ArrowRight") to = (playing + 1) % STEPS.length;
  if (event.key === "ArrowLeft") to = (playing - 1 + STEPS.length) % STEPS.length;
  if (/^[1-5]$/.test(event.key)) to = Number(event.key) - 1;
  if (to === null) return;
  event.preventDefault();
  hold();
  goTo(to);
});
still.addEventListener("change", () => { touring = !still.matches; run(); });
draw();
goTo(0);
`;

const body = k.plateHtml({
  fig: "Fig 1",
  title: "Pseudonyms",
  hint: "Click a step or press ← →",
  readout: `tokens left ${TOKENS_PER_EPOCH} of ${TOKENS_PER_EPOCH} · spent 0`,
  keys: [
    { mark: "lit", label: "The token: random bytes the PDS never sees bare" },
    { mark: "raised", label: "The hood: a carbon-lined envelope with your nameplate on it" },
    { mark: "edge", label: `The key: ${KEY_TEETH} cuts, one per word of the phrase` },
  ],
  caption:
    "The press stamps the envelope while it can read your nameplate, and later punches a bare token that has no name on it. Nothing ties the two visits together, so the PDS can't link a pseudonym to its owner. Each approved account gets 20 tokens a month (blind RSA signatures, RFC 9474). A spent token leaves only a hash, so it can't be spent twice. Every pseudonym's DID carries sha256(owner + salt). Only the owner's 12 words can show that the seal names them.",
  body: `<div class="iso-stage" tabindex="0" role="button" aria-label="Pseudonym bench: click or press the arrow keys to step through">${svg}</div>${stepper}`,
});

const file = theme === "light" ? "pseudonyms-light.html" : "pseudonyms.html";
writeFileSync(join(HERE, file), k.pageHtml({ title: "How pseudonyms work", theme, body: `<style>${CSS}</style>${body}`, script: kitScript() + live }));
console.log("wrote", file);
