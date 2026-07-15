// Procedural first-person gun models — boxes and cylinders composed into
// distinct silhouettes. No hands anywhere; guns float with weight conveyed
// through animation. Each builder returns { group, mag, slide, muzzle }.

import * as THREE from "three";

const _mats = new Map();
function mat(color, { rough = 0.55, metal = 0.35, emissive = null } = {}) {
  const key = color + rough + metal + (emissive || "");
  if (_mats.has(key)) return _mats.get(key);
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: metal,
  });
  if (emissive) {
    m.emissive = new THREE.Color(emissive);
    m.emissiveIntensity = 0.9;
  }
  m.userData.shared = true; // survives session disposal
  _mats.set(key, m);
  return m;
}

// palette
const STEEL = "#9aa6b2";
const DARK = "#55616d";
const CHARGRIP = "#6d7a86";
const TEAL = "#2dd4bf";
const ORANGE = "#ff7a1a";
const CREAM = "#f2ead8";
const WOODY = "#b98a5e";

function box(parent, x, y, z, sx, sy, sz, material, rz = 0, rx = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  m.position.set(x, y, z);
  if (rz) m.rotation.z = rz;
  if (rx) m.rotation.x = rx;
  parent.add(m);
  return m;
}

function cyl(parent, x, y, z, r, len, material, alongZ = true, rTop = null, seg = 12) {
  const g = new THREE.CylinderGeometry(rTop ?? r, r, len, seg);
  const m = new THREE.Mesh(g, material);
  if (alongZ) m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------------------

function buildHavoc() {
  const g = new THREE.Group();
  const steel = mat(STEEL), dark = mat(DARK), accent = mat(TEAL, { emissive: TEAL, rough: 0.4 });

  box(g, 0, 0, 0.02, 0.075, 0.1, 0.34, steel); // receiver
  box(g, 0, 0.014, -0.26, 0.062, 0.062, 0.3, dark); // handguard
  cyl(g, 0, 0.012, -0.5, 0.017, 0.22, steel); // barrel
  cyl(g, 0, 0.012, -0.605, 0.024, 0.05, dark); // muzzle brake
  box(g, 0, 0.075, -0.05, 0.03, 0.028, 0.3, dark); // top rail
  box(g, 0, 0.1, -0.24, 0.012, 0.05, 0.012, dark); // front post
  box(g, 0, 0.095, 0.05, 0.026, 0.04, 0.05, dark); // rear sight block
  box(g, 0, -0.07, 0.11, 0.05, 0.09, 0.07, dark, 0.25); // grip
  box(g, 0, 0.005, 0.24, 0.055, 0.085, 0.14, dark); // stock
  box(g, 0, -0.02, 0.31, 0.05, 0.11, 0.03, steel); // stock pad
  box(g, 0.0, -0.015, -0.1, 0.078, 0.012, 0.2, accent); // side stripe
  const magM = box(g, 0, -0.1, -0.02, 0.042, 0.13, 0.075, mat(CHARGRIP), 0, 0.28); // magazine
  const slide = box(g, 0.045, 0.03, 0.06, 0.014, 0.03, 0.08, dark); // charging handle

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.64);
  g.add(muzzle);
  return { group: g, mag: magM, slide, muzzle };
}

function buildMauler() {
  const g = new THREE.Group();
  const steel = mat(STEEL), dark = mat(DARK), wood = mat(WOODY, { rough: 0.7, metal: 0.05 });
  const accent = mat(ORANGE, { emissive: ORANGE, rough: 0.4 });

  box(g, 0, 0, 0.06, 0.085, 0.105, 0.3, steel); // receiver
  cyl(g, 0, 0.026, -0.28, 0.026, 0.5, dark); // barrel
  cyl(g, 0, -0.028, -0.26, 0.02, 0.44, steel); // tube mag
  const magM = box(g, 0, -0.028, -0.33, 0.062, 0.05, 0.14, wood); // pump grip (mag anim = pump)
  box(g, 0, 0.09, 0.0, 0.024, 0.024, 0.22, dark); // top rib
  box(g, 0, 0.105, -0.5, 0.012, 0.02, 0.012, accent); // bead sight
  box(g, 0, -0.075, 0.17, 0.055, 0.1, 0.08, wood, 0.32); // grip
  box(g, 0, -0.005, 0.31, 0.06, 0.1, 0.16, wood); // stock
  box(g, 0, -0.015, -0.03, 0.09, 0.02, 0.16, accent); // hazard band
  const slide = box(g, 0.05, 0.02, 0.12, 0.014, 0.026, 0.05, dark);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.026, -0.56);
  g.add(muzzle);
  return { group: g, mag: magM, slide, muzzle };
}

function buildLongbow() {
  const g = new THREE.Group();
  const steel = mat("#aebccb"), dark = mat(DARK), accent = mat("#7cc4ff", { emissive: "#7cc4ff", rough: 0.3 });

  box(g, 0, 0, 0.1, 0.07, 0.095, 0.4, steel); // body
  cyl(g, 0, 0.02, -0.42, 0.019, 0.62, dark); // long barrel
  cyl(g, 0, 0.02, -0.74, 0.028, 0.045, steel); // brake
  box(g, 0, -0.045, -0.28, 0.05, 0.05, 0.34, steel); // fore-end
  // scope
  cyl(g, 0, 0.115, -0.02, 0.032, 0.24, dark);
  cyl(g, 0, 0.115, -0.15, 0.038, 0.04, dark);
  cyl(g, 0, 0.115, 0.1, 0.036, 0.04, dark);
  const lens = cyl(g, 0, 0.115, -0.172, 0.03, 0.006, accent);
  box(g, 0, 0.075, -0.02, 0.02, 0.045, 0.06, dark); // scope mount
  box(g, 0, -0.08, 0.2, 0.05, 0.1, 0.075, dark, 0.3); // grip
  box(g, 0, -0.005, 0.35, 0.055, 0.1, 0.16, steel); // stock
  box(g, 0, -0.06, 0.34, 0.05, 0.05, 0.12, dark); // cheek
  const slide = box(g, 0.055, 0.035, 0.13, 0.016, 0.05, 0.016, steel, -0.5); // bolt handle
  const magM = box(g, 0, -0.085, 0.05, 0.04, 0.07, 0.09, dark); // box mag
  // bipod stubs
  box(g, 0.03, -0.09, -0.48, 0.012, 0.09, 0.012, dark, 0.35);
  box(g, -0.03, -0.09, -0.48, 0.012, 0.09, 0.012, dark, -0.35);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.78);
  g.add(muzzle);
  return { group: g, mag: magM, slide, muzzle, lens };
}

function buildOgre() {
  const g = new THREE.Group();
  const dark = mat(DARK), steel = mat(STEEL);
  const warn = mat(ORANGE, { emissive: ORANGE, rough: 0.45 });
  const creamM = mat(CREAM, { rough: 0.6, metal: 0.1 });

  cyl(g, 0, 0.02, -0.1, 0.062, 0.62, creamM); // main tube
  cyl(g, 0, 0.02, -0.44, 0.075, 0.1, dark); // front bell
  cyl(g, 0, 0.02, -0.5, 0.085, 0.03, warn, true, 0.085); // front ring
  cyl(g, 0, 0.02, 0.26, 0.075, 0.14, dark, true, 0.09); // exhaust cone
  box(g, 0, 0.1, -0.12, 0.02, 0.05, 0.02, steel); // front sight
  box(g, 0, 0.1, 0.05, 0.024, 0.045, 0.03, steel); // rear sight
  box(g, 0, -0.09, 0.05, 0.05, 0.1, 0.07, dark, 0.25); // grip
  box(g, 0, -0.085, -0.16, 0.05, 0.08, 0.06, dark); // front handle
  // hazard stripes
  for (let i = 0; i < 3; i++) {
    box(g, 0, 0.083, -0.02 - i * 0.09, 0.065, 0.012, 0.045, i % 2 ? warn : creamM);
  }
  const magM = cyl(g, 0, 0.02, -0.3, 0.05, 0.16, warn); // visible rocket tip (reload anim)
  const slide = box(g, 0.07, 0.02, 0.1, 0.02, 0.02, 0.06, steel);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.54);
  g.add(muzzle);
  return { group: g, mag: magM, slide, muzzle };
}

function buildVespa() {
  const g = new THREE.Group();
  const steel = mat("#b8c2cc"), dark = mat(DARK), accent = mat(TEAL, { emissive: TEAL, rough: 0.4 });

  const slide = box(g, 0, 0.035, -0.03, 0.055, 0.055, 0.24, steel); // slide
  box(g, 0, -0.005, -0.02, 0.05, 0.04, 0.2, dark); // frame
  cyl(g, 0, 0.035, -0.165, 0.014, 0.04, dark); // barrel tip
  box(g, 0, -0.065, 0.06, 0.045, 0.1, 0.065, dark, 0.28); // grip
  box(g, 0, 0.07, -0.13, 0.01, 0.014, 0.014, accent); // front sight
  box(g, 0, 0.07, 0.075, 0.024, 0.012, 0.014, dark); // rear sight
  box(g, 0, -0.02, -0.135, 0.052, 0.02, 0.03, accent); // accent chin
  const magM = box(g, 0, -0.1, 0.055, 0.034, 0.08, 0.05, steel, 0, 0.24);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.035, -0.2);
  g.add(muzzle);
  return { group: g, mag: magM, slide, muzzle };
}

export const GUN_BUILDERS = {
  havoc: buildHavoc,
  mauler: buildMauler,
  longbow: buildLongbow,
  ogre: buildOgre,
  vespa: buildVespa,
};
