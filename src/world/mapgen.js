// Arena builder. Three handcrafted-skeleton layouts (Bazaar, Frosthold,
// Mesa) with seeded prop variation + seeded sun/time-of-day, so every match
// reads fresh. Outputs merged visuals, collision world, nav grid, spawn
// points, pickup spots and lighting.

import * as THREE from "three";
import { Kit } from "./kit.js";
import { createSky } from "./sky.js";
import { StaticWorld } from "./collision.js";
import { NavGrid } from "./nav.js";
import { mulberry32, pick, randRange, randInt } from "../core/utils.js";

export const ARENA_HALF = 36;

// ---------------------------------------------------------------------------
// theme data
// ---------------------------------------------------------------------------

const THEMES = {
  bazaar: {
    label: "BAZAAR",
    ground: "#e3bd85",
    suns: [
      { dir: [0.5, 1.0, 0.3], color: "#fff4e0", intensity: 1.25, fog: "#f6e7c8", skyTop: "#6fc0ee", skyHorizon: "#fdeecd" },
      { dir: [0.9, 0.5, 0.35], color: "#ffd9a0", intensity: 1.15, fog: "#f8ddb5", skyTop: "#7fb8e8", skyHorizon: "#ffe2b8" },
      { dir: [-0.6, 0.85, 0.4], color: "#fff8ec", intensity: 1.3, fog: "#f2ead6", skyTop: "#79c6f0", skyHorizon: "#f8ecd2" },
    ],
    wall: "#efd9ae",
    wallTrim: "#c96f4a",
    accents: ["#e2574c", "#2a9d8f", "#e9a03b", "#7c6bb8"],
    cream: "#f6efdd",
    crate: "#c08a55",
    wood: "#9c6b4a",
    leaf: "#5fa052",
  },
  frosthold: {
    label: "FROSTHOLD",
    ground: "#edf3f7",
    suns: [
      { dir: [0.6, 0.9, 0.4], color: "#ffffff", intensity: 1.32, fog: "#e8f2f8", skyTop: "#8fd0f5", skyHorizon: "#eef7fb" },
      { dir: [0.85, 0.5, 0.3], color: "#ffeccf", intensity: 1.2, fog: "#eaf0f6", skyTop: "#9cc8ea", skyHorizon: "#f6ecd9" },
    ],
    wall: "#dee8ee",
    wallTrim: "#7899a8",
    accents: ["#e56b5d", "#2a9d8f", "#e9c46a", "#7fb069"],
    cream: "#f8fafc",
    crate: "#cfe3ee",
    wood: "#8a9aa5",
    leaf: "#3f7d54",
  },
  mesa: {
    label: "MESA",
    ground: "#dfa06e",
    suns: [
      { dir: [0.55, 0.95, 0.25], color: "#fff1dd", intensity: 1.28, fog: "#f5dfc0", skyTop: "#86c5ec", skyHorizon: "#ffe3bd" },
      { dir: [0.95, 0.45, 0.4], color: "#ffc98a", intensity: 1.12, fog: "#f6d9ad", skyTop: "#8cb8e4", skyHorizon: "#ffd9a4" },
    ],
    wall: "#d98e63",
    wallTrim: "#8a5a3a",
    accents: ["#c96f4a", "#2a9d8f", "#e9a03b", "#b85a38"],
    cream: "#eed9b8",
    crate: "#a97648",
    wood: "#8a5a3a",
    leaf: "#5c9e58",
  },
};

// smooth deterministic value noise for ground painting
function makeNoise(rng) {
  const seed = rng() * 1000;
  const hash = (ix, iz) => {
    const s = Math.sin(ix * 127.1 + iz * 311.7 + seed) * 43758.5453;
    return s - Math.floor(s);
  };
  return (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
}

// ---------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------

function perimeter(kit, T, half, rng) {
  const h = 5, th = 1.2, L = half * 2 + 2.4;
  kit.box(0, 0, -half - th / 2, L, h, th, T.wall, { jitter: 0.02 });
  kit.box(0, 0, half + th / 2, L, h, th, T.wall, { jitter: 0.02 });
  kit.box(-half - th / 2, 0, 0, th, h, L, T.wall, { jitter: 0.02 });
  kit.box(half + th / 2, 0, 0, th, h, L, T.wall, { jitter: 0.02 });
  // trim line on top
  kit.box(0, h, -half - th / 2, L, 0.3, th + 0.2, T.wallTrim, { collide: false });
  kit.box(0, h, half + th / 2, L, 0.3, th + 0.2, T.wallTrim, { collide: false });
  kit.box(-half - th / 2, h, 0, th + 0.2, 0.3, L, T.wallTrim, { collide: false });
  kit.box(half + th / 2, h, 0, th + 0.2, 0.3, L, T.wallTrim, { collide: false });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.box(sx * half, 0, sz * half, 4.6, 7, 4.6, T.wall, { jitter: 0.03 });
      kit.box(sx * half, 7, sz * half, 5.2, 0.5, 5.2, T.wallTrim, { collide: false });
    }
  }
}

function crateCluster(kit, T, x, z, rng) {
  const r = rng();
  const rot = rng() * Math.PI;
  kit.box(x, 0, z, 1.15, 1.15, 1.15, T.crate, { rotY: rot });
  if (r > 0.35) kit.box(x + 1.15, 0, z + 0.25, 0.85, 0.85, 0.85, T.crate, { rotY: rot + 0.4 });
  if (r > 0.6) kit.box(x + 0.4, 1.15, z + 0.1, 0.85, 0.85, 0.85, T.crate, { rotY: rot - 0.3, nav: false });
  if (r > 0.8) kit.cyl(x - 1.1, 0, z + 0.9, 0.42, 0.95, pick(rng, T.accents));
}

function lowWall(kit, T, x, z, rotY, len = 3) {
  kit.box(x, 0, z, len, 1.05, 0.35, T.cream, { rotY });
  kit.box(x, 1.05, z, len + 0.15, 0.12, 0.5, T.wallTrim, { rotY, collide: false });
}

// ---------------------------------------------------------------------------
// BAZAAR
// ---------------------------------------------------------------------------

function layoutBazaar(kit, T, rng, refs) {
  // central fountain plaza
  kit.cyl(0, 0, 0, 3.1, 0.9, "#e8d9b8", { seg: 14 });
  kit.cyl(0, 0.55, 0, 2.55, 0.42, "#8fd8e4", { seg: 14, glow: true, collide: false });
  kit.cyl(0, 0, 0, 0.62, 2.5, "#dcc79a", { seg: 10 });
  kit.blob(0, 2.45, 0, 0.5, 1, "#8fd8e4", { collide: false });

  // planters on plaza diagonals
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      kit.box(sx * 7, 0, sz * 7, 1.7, 0.65, 1.7, T.wallTrim, { jitter: 0.03 });
      kit.blob(sx * 7, 0.65, sz * 7, 0.85, 0.7, T.leaf);
    }

  // market stall rows (east/west), seeded presence
  const stall = (x, z, rot) => {
    const a = pick(rng, T.accents);
    kit.box(x, 0, z, 2.6, 1.05, 1.15, T.wood, { rotY: rot });
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const [lx, lz] of [[-1.2, -0.7], [1.2, -0.7], [-1.2, 0.7], [1.2, 0.7]]) {
      kit.cyl(x + lx * c + lz * s, 0, z - lx * s + lz * c, 0.09, 2.35, T.wood, { collide: false, seg: 6 });
    }
    for (let i = 0; i < 5; i++) {
      const lx = -1.3 + i * 0.65;
      kit.box(x + lx * c, 2.35, z - lx * s, 0.62, 0.07, 2.0, i % 2 ? T.cream : a, { rotY: rot, collide: false });
    }
    // goods
    kit.box(x + 0.5 * c, 1.05, z - 0.5 * s, 0.5, 0.35, 0.5, pick(rng, T.accents), { rotY: rot, collide: false });
    kit.box(x - 0.6 * c, 1.05, z + 0.6 * s, 0.4, 0.28, 0.6, pick(rng, T.accents), { rotY: rot + 0.3, collide: false });
  };
  for (const sx of [-1, 1]) {
    stall(sx * 13.5, -7 + randRange(rng, -1, 1), 0);
    stall(sx * 13.5, 1 + randRange(rng, -1, 1), 0);
    stall(sx * 13.5, 9 + randRange(rng, -1, 1), 0);
  }

  // arch gates north/south lanes
  for (const sz of [-1, 1]) {
    const z = sz * 13;
    for (const sx of [-1, 1]) kit.box(sx * 2.6, 0, z, 1.1, 3.7, 1.1, T.wall);
    kit.box(0, 3.7, z, 6.3, 0.95, 1.2, T.wall, { nav: false });
    kit.box(0, 4.65, z, 6.8, 0.35, 1.4, T.wallTrim, { collide: false });
    // pennant string
    for (let i = 0; i < 7; i++) {
      kit.box(-2.1 + i * 0.7, 3.35, z, 0.3, 0.24, 0.03, T.accents[i % T.accents.length], { collide: false, glow: true });
    }
  }

  // corner buildings
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * 26, z = sz * 26;
      kit.box(x, 0, z, 10.5, 5.4, 10.5, T.wall, { jitter: 0.02 });
      kit.box(x, 5.4, z, 11.1, 0.5, 11.1, T.wallTrim, { collide: false });
      // windows + door (visual insets)
      kit.box(x - sx * 5.3, 2.6, z - 2.5, 0.14, 1.2, 1.0, "#7a6a52", { collide: false });
      kit.box(x - sx * 5.3, 2.6, z + 2.5, 0.14, 1.2, 1.0, "#7a6a52", { collide: false });
      kit.box(x - 2.5, 0, z - sz * 5.3, 1.4, 2.6, 0.14, "#7a6a52", { collide: false });
      // awning over door
      kit.box(x - 2.5, 2.7, z - sz * (5.3 + 0.45), 2.0, 0.08, 1.0, pick(rng, T.accents), { collide: false });
    }

  // mid cover: low walls flanking plaza
  lowWall(kit, T, -6.5, -10.5 + randRange(rng, -0.8, 0.8), 0.2);
  lowWall(kit, T, 6.5, 10.5 + randRange(rng, -0.8, 0.8), -0.2);
  lowWall(kit, T, -18, 0 + randRange(rng, -1, 1), Math.PI / 2);
  lowWall(kit, T, 18, 0 + randRange(rng, -1, 1), Math.PI / 2);

  // seeded crate clusters
  const spots = [
    [-20, -14], [20, 14], [-9, 20], [9, -20], [-24, 6], [24, -6],
    [-4, -24], [4, 24], [14, -13], [-14, 13], [22, 22], [-22, -22],
  ];
  for (const [x, z] of spots) if (rng() > 0.25) crateCluster(kit, T, x + randRange(rng, -1, 1), z + randRange(rng, -1, 1), rng);

  // palms
  const palms = [[-24, -2], [24, 2], [-10, 27], [10, -27], [27, 10], [-27, -10]];
  for (const [x, z] of palms) {
    if (rng() < 0.2) continue;
    kit.cyl(x, 0, z, 0.24, 3.5, T.wood, { seg: 7 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng();
      kit.box(x + Math.cos(a) * 1.05, 3.4, z + Math.sin(a) * 1.05, 2.15, 0.07, 0.55, T.leaf, { rotY: -a, collide: false });
    }
    kit.blob(x, 3.2, z, 0.34, 0.8, "#7a4a2a", { collide: false });
  }

  // rugs near plaza
  for (const [x, z, r] of [[0, 8.5, 0], [0, -8.5, 0], [8.5, 0, Math.PI / 2], [-8.5, 0, Math.PI / 2]]) {
    kit.mat(x, z, 2.2, 3.2, pick(rng, T.accents), { rotY: r, jitter: 0.12 });
  }

  // NOTE: corner buildings occupy (±26,±26)±5.25 — keep spawns off them
  refs.botSpawns = [
    [-28, -18], [28, 18], [-18, 28], [18, -28],
    [0, -30], [-30, 0], [30, 0], [-14, -29], [14, -29], [29, 14],
  ];
  refs.pickups = [
    { x: -18, z: -7, kind: "health" }, { x: 18, z: 7, kind: "health" },
    { x: 0, z: 18.5, kind: "ammo" }, { x: 0, z: -18.5, kind: "ammo" },
  ];
}

// ---------------------------------------------------------------------------
// FROSTHOLD
// ---------------------------------------------------------------------------

function layoutFrosthold(kit, T, rng, refs) {
  // central raised pad + stairs east/west
  kit.box(0, 0, 0, 8, 1.6, 8, "#dfe7ec", { jitter: 0.02 });
  kit.box(0, 1.6, 0, 8.4, 0.18, 8.4, "#cdd9e2", { collide: false });
  kit.stairs(6.2, 0, 0, 3, 0.4, 0.56, 4, "#cdd9e2", 0);
  kit.stairs(-6.2, 0, 0, 3, 0.4, 0.56, 4, "#cdd9e2", Math.PI);
  // corner rails on pad
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    kit.box(sx * 3.6, 1.78, sz * 3.6, 0.9, 0.75, 0.14, "#9fb4c2", { rotY: sz * 0.0, nav: false });
    kit.box(sx * 3.6, 1.78, sz * 3.6, 0.14, 0.75, 0.9, "#9fb4c2", { nav: false });
  }
  // antenna
  kit.cyl(3.2, 1.78, -3.2, 0.09, 3.4, "#8fa5b2", { seg: 6, collide: false });
  kit.blob(3.2, 5.1, -3.2, 0.2, 1, "#ff5a4e", { collide: false, glow: true });

  // container yard — seeded mix
  const container = (x, z, rot, c, stack) => {
    kit.box(x, 0, z, 5.6, 2.5, 2.4, c, { rotY: rot, jitter: 0.04 });
    kit.box(x, 2.5, z, 5.7, 0.14, 2.5, "#ffffff", { rotY: rot, collide: false, jitter: 0.02 });
    if (stack) {
      kit.box(x + randRange(rng, -0.4, 0.4), 2.64, z + randRange(rng, -0.2, 0.2), 5.6, 2.5, 2.4, pick(rng, T.accents), { rotY: rot + randRange(rng, -0.06, 0.06), nav: false });
    }
  };
  const cSpots = [
    [-14, -5, 0], [-13.5, 4, 0], [14, -3, 0.28], [13, 8, 0],
    [-4, -17, Math.PI / 2], [5, 16, Math.PI / 2], [21, -18, 0], [-21, 13, Math.PI / 2],
    [19, 20, 0.2], [-19, -20, 0],
  ];
  let placed = 0;
  for (const [x, z, r] of cSpots) {
    if (rng() < 0.2 && placed > 4) continue;
    container(x + randRange(rng, -0.8, 0.8), z + randRange(rng, -0.8, 0.8), r, pick(rng, T.accents), rng() > 0.55);
    placed++;
  }

  // pines around edges
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + rng() * 0.5;
    const r = randRange(rng, 26, 31);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < 6 && z > 20) continue; // keep player spawn clear
    kit.cyl(x, 0, z, 0.26, 1.1, "#7a5a42", { seg: 6 });
    kit.cone(x, 0.9, z, 1.5, 2.2, T.leaf);
    kit.cone(x, 2.6, z, 1.1, 1.8, T.leaf);
    kit.cone(x, 4.0, z, 0.7, 1.4, "#eef6f9");
  }

  // snow piles (visual)
  for (let i = 0; i < 7; i++) {
    kit.blob(randRange(rng, -30, 30), 0, randRange(rng, -30, 30), randRange(rng, 1.2, 2.4), 0.32, "#f7fafc", { collide: false });
  }

  // ice crates + barriers
  const crates = [[-8, 10], [8, -10], [-16, -13], [16, 13], [0, 24], [0, -24], [-25, 2], [25, -2]];
  for (const [x, z] of crates) if (rng() > 0.3) crateCluster(kit, T, x + randRange(rng, -1, 1), z + randRange(rng, -1, 1), rng);
  lowWall(kit, T, -7, -13, 0.3, 3.4);
  lowWall(kit, T, 7, 13, -0.3, 3.4);
  lowWall(kit, T, 0, 9.5, Math.PI / 2, 3);
  lowWall(kit, T, 0, -9.5, Math.PI / 2, 3);

  // lamp posts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 10.5, z = sz * 10.5;
    kit.cyl(x, 0, z, 0.11, 3.3, "#6b7a86", { seg: 6 });
    kit.box(x, 3.3, z, 0.5, 0.4, 0.5, "#ffdf8a", { collide: false, glow: true });
  }

  refs.botSpawns = [
    [-29, -29], [29, 29], [-29, 29], [29, -29],
    [0, -31], [-31, 0], [31, 0], [-16, -30], [16, -30], [30, 16],
  ];
  refs.pickups = [
    { x: -19, z: 8, kind: "health" }, { x: 19, z: -8, kind: "health" },
    { x: -8, z: -21, kind: "ammo" }, { x: 8, z: 21, kind: "ammo" },
  ];
}

// ---------------------------------------------------------------------------
// MESA
// ---------------------------------------------------------------------------

function layoutMesa(kit, T, rng, refs) {
  const strata = ["#c96f4a", "#b85a38", "#d98e63", "#e8b088"];

  const rock = (x, z, s) => {
    let y = 0;
    const layers = randInt(rng, 3, 4);
    for (let i = 0; i < layers; i++) {
      const w = (6 - i * 1.1) * s;
      const h = (1.9 - i * 0.15) * s;
      kit.box(x + randRange(rng, -0.4, 0.4) * s, y, z + randRange(rng, -0.4, 0.4) * s, w, h, w * randRange(rng, 0.75, 1.05), strata[i % strata.length], {
        rotY: randRange(rng, -0.25, 0.25),
        jitter: 0.06,
      });
      y += h;
    }
  };
  rock(-18, -12, 1);
  rock(20, -16, 0.85);
  rock(-22, 14, 0.9);
  rock(16, 18, 0.75);

  // central watchtower (climbable power position)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    kit.cyl(sx * 1.7, 0, sz * 1.7, 0.24, 3.5, T.wood, { seg: 7 });
  }
  kit.box(0, 3.5, 0, 4.6, 0.4, 4.6, "#a06e46", { nav: false });
  for (const sx of [-1, 1]) {
    kit.box(sx * 2.25, 3.9, 0, 0.12, 0.85, 4.6, "#8a5a3a", { nav: false });
    kit.box(0, 3.9, sx * 2.25, 4.6, 0.85, 0.12, "#8a5a3a", { nav: false });
  }
  kit.stairs(4.9, 0, 0, 2.6, 0.5, 0.62, 7, "#a06e46", 0);
  kit.cone(0, 4.75, 0, 0.14, 1.6, T.wood, { collide: false, seg: 5 });
  kit.box(0.35, 5.9, 0, 0.7, 0.45, 0.05, "#e2574c", { collide: false, glow: true });

  // adobe houses
  const house = (x, z, rot) => {
    kit.box(x, 0, z, 6.2, 3.3, 5.2, "#e5c096", { rotY: rot, jitter: 0.03 });
    kit.box(x, 3.3, z, 6.5, 0.35, 5.5, "#d9a873", { rotY: rot, collide: false });
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let i = -2; i <= 2; i++) {
      kit.cyl(x + i * 1.1 * c + 3.15 * s, 2.8, z - i * 1.1 * s + 3.15 * c, 0.09, 0.5, T.wood, { collide: false, seg: 5 });
    }
    kit.box(x + 3.12 * s, 0, z + 3.12 * c, 1.3, 2.3, 0.15, "#5c4632", { rotY: rot, collide: false });
    kit.box(x - 2 * c + 3.12 * s, 1.6, z + 2 * s + 3.12 * c, 0.9, 0.9, 0.15, "#5c4632", { rotY: rot, collide: false });
  };
  house(-14, 8, 0);
  house(14, -8, Math.PI);

  // cacti
  for (let i = 0; i < 8; i++) {
    const x = randRange(rng, -30, 30), z = randRange(rng, -30, 30);
    if (Math.abs(x) < 9 && Math.abs(z) < 9) continue;
    if (Math.abs(x) < 6 && z > 20) continue;
    const h = randRange(rng, 1.7, 2.7);
    kit.cyl(x, 0, z, 0.34, h, T.leaf, { seg: 8 });
    kit.blob(x, h, z, 0.3, 0.6, T.leaf, { collide: false });
    if (rng() > 0.4) {
      kit.cyl(x + 0.55, h * 0.45, z, 0.2, 0.9, T.leaf, { seg: 6, collide: false });
    }
  }

  // wood fence lines (shoot-through cover)
  const fence = (x0, z0, x1, z1) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.floor(len / 1.8);
    const rot = Math.atan2(-dz, dx);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      kit.cyl(x0 + dx * t, 0, z0 + dz * t, 0.09, 1.15, T.wood, { seg: 5 });
    }
    kit.box(x0 + dx / 2, 0.55, z0 + dz / 2, len, 0.09, 0.07, T.wood, { rotY: rot, collide: false });
    kit.box(x0 + dx / 2, 0.92, z0 + dz / 2, len, 0.09, 0.07, T.wood, { rotY: rot, collide: false });
  };
  fence(-8, -18, -2, -24);
  fence(8, 18, 2, 24);
  fence(-26, -4, -20, -4);
  fence(26, 4, 20, 4);

  // crates/barrels
  const crates = [[-10, 18], [10, -18], [-20, -20], [20, 20], [-26, 24], [26, -24], [0, -13], [0, 13]];
  for (const [x, z] of crates) if (rng() > 0.3) crateCluster(kit, T, x + randRange(rng, -1, 1), z + randRange(rng, -1, 1), rng);
  lowWall(kit, T, -9, 0, Math.PI / 2, 3.2);
  lowWall(kit, T, 9, 0, Math.PI / 2, 3.2);

  refs.botSpawns = [
    [-28, -28], [28, 28], [-28, 28], [28, -28],
    [0, -30], [-30, 0], [30, 0], [-15, -29], [15, -29], [29, -14],
  ];
  refs.pickups = [
    { x: -14, z: -6, kind: "health" }, { x: 14, z: 6, kind: "health" },
    { x: -6, z: 22, kind: "ammo" }, { x: 6, z: -22, kind: "ammo" },
  ];
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

const LAYOUTS = { bazaar: layoutBazaar, frosthold: layoutFrosthold, mesa: layoutMesa };

export function buildMap(scene, mapName, seed) {
  const rng = mulberry32(seed);
  let name = mapName;
  if (!LAYOUTS[name]) {
    name = pick(rng, Object.keys(LAYOUTS));
  }
  const T = THEMES[name];
  const sun = pick(rng, T.suns);

  const half = ARENA_HALF;
  const statics = new StaticWorld(half + 6);
  const nav = new NavGrid(half, 1);
  const kit = new Kit(statics, nav, rng);

  // ground with painted paths/plaza
  const noise = makeNoise(rng);
  const base = new THREE.Color(T.ground);
  const pathC = base.clone().multiplyScalar(0.85);
  const plazaC = base.clone().multiplyScalar(0.91);
  kit.ground(half + 1.5, 52, (x, z, out) => {
    out.copy(base);
    const d = Math.sqrt(x * x + z * z);
    if (d < 10) out.copy(plazaC);
    if (Math.abs(x) < 2.4 || Math.abs(z) < 2.4) out.copy(pathC);
    const n = noise(x * 0.18 + 100, z * 0.18 + 100);
    out.multiplyScalar(0.94 + n * 0.11);
  });

  const refs = { botSpawns: [], pickups: [] };
  LAYOUTS[name](kit, T, rng, refs);
  perimeter(kit, T, half, rng);

  // Snap every bot spawn to the nearest open nav cell so seeded props (or
  // layout mistakes) can never trap a bot inside solid geometry. Points that
  // can only snap far away are deep inside a structure — drop them.
  const snapped = [];
  for (const [x, z] of refs.botSpawns) {
    const idx = nav.nearestOpen(x, z);
    if (idx < 0) continue;
    const sx = nav.cellCenterX(idx % nav.n);
    const sz = nav.cellCenterZ((idx / nav.n) | 0);
    if ((sx - x) ** 2 + (sz - z) ** 2 > 6 * 6) continue;
    snapped.push([sx, sz]);
  }
  refs.botSpawns = snapped;

  // spawn pad markers (soft glow rings)
  for (const [x, z] of refs.botSpawns) {
    kit.mat(x, z, 1.7, 1.7, "#f3c1b5", { glow: true, jitter: 0 });
  }

  const disposeKit = kit.build(scene);
  statics.finalize();

  // lighting
  const hemi = new THREE.HemisphereLight(new THREE.Color(sun.skyTop).lerp(new THREE.Color("#ffffff"), 0.35), new THREE.Color(T.ground).multiplyScalar(0.55), 0.85);
  scene.add(hemi);

  const sunDir = new THREE.Vector3(...sun.dir).normalize();
  const dir = new THREE.DirectionalLight(sun.color, sun.intensity);
  dir.position.copy(sunDir).multiplyScalar(80);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.left = -half - 8;
  dir.shadow.camera.right = half + 8;
  dir.shadow.camera.top = half + 8;
  dir.shadow.camera.bottom = -half - 8;
  dir.shadow.camera.near = 10;
  dir.shadow.camera.far = 180;
  dir.shadow.bias = -0.0004;
  dir.shadow.normalBias = 0.5;
  scene.add(dir);
  scene.add(dir.target);

  scene.fog = new THREE.Fog(new THREE.Color(sun.fog), 80, 230);

  const sky = createSky(scene, { skyTop: sun.skyTop, skyHorizon: sun.skyHorizon, sunColor: sun.color, sunDir: sun.dir }, rng);

  const playerSpawn = { x: 0, z: half - 7, yaw: 0 };

  return {
    name,
    label: T.label,
    seed,
    statics,
    nav,
    half,
    playerSpawn,
    botSpawns: refs.botSpawns,
    pickups: refs.pickups,
    sunDir,
    lights: { hemi, dir },
    skyUpdate: sky.update,
    dispose() {
      disposeKit();
      sky.dispose();
      scene.remove(hemi);
      scene.remove(dir);
      scene.remove(dir.target);
      scene.fog = null;
    },
  };
}
