// Geometry kit: every static prop is baked into two merged vertex-colored
// meshes (lit + unlit/glow), so an entire arena renders in ~2 draw calls.
// Boxes register collision AABBs and stamp the nav grid as they're placed.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

// mergeGeometries requires all-indexed or all-non-indexed; icospheres are
// non-indexed, so normalize everything to non-indexed.
function deindex(geo) {
  if (!geo.index) return geo;
  const ni = geo.toNonIndexed();
  geo.dispose();
  return ni;
}

export class Kit {
  constructor(world, nav, rng) {
    this.world = world;
    this.nav = nav;
    this.rng = rng;
    this.lit = [];
    this.glow = [];
  }

  _paint(geo, color, opts = {}) {
    const jitter = opts.jitter ?? 0.05;
    const ao = opts.ao !== false;
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    _c.set(color);
    const jm = 1 + (this.rng() * 2 - 1) * jitter;
    let r = _c.r * jm, g = _c.g * jm, b = _c.b * jm;
    r = Math.min(r, 1); g = Math.min(g, 1); b = Math.min(b, 1);
    for (let i = 0; i < pos.count; i++) {
      let f = 1;
      if (ao) {
        const y = pos.getY(i);
        f = 0.84 + 0.16 * Math.min(Math.max(y / 1.6, 0), 1);
      }
      colors[i * 3] = r * f;
      colors[i * 3 + 1] = g * f;
      colors[i * 3 + 2] = b * f;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }

  _bake(geo, x, y, z, rotY) {
    if (rotY) {
      _q.setFromAxisAngle(_up, rotY);
      _m.makeRotationFromQuaternion(_q);
      geo.applyMatrix4(_m);
    }
    _m.makeTranslation(x, y, z);
    geo.applyMatrix4(_m);
  }

  _navFromBox(x0, y0, z0, x1, y1, z1) {
    if (!this.nav) return;
    if (y0 < 1.5 && y1 > 0.32 && y1 - y0 >= 0.35) {
      this.nav.blockRect(x0 - 0.45, z0 - 0.45, x1 + 0.45, z1 + 0.45);
    }
  }

  // Box with base at (x, y, z), size sx × sy × sz, optional Y rotation.
  box(x, y, z, sx, sy, sz, color, opts = {}) {
    const geo = deindex(new THREE.BoxGeometry(sx, sy, sz));
    this._bake(geo, x, y + sy / 2, z, opts.rotY || 0);
    this._paint(geo, color, opts);
    (opts.glow ? this.glow : this.lit).push(geo);

    if (opts.collide !== false) {
      const cos = Math.abs(Math.cos(opts.rotY || 0));
      const sin = Math.abs(Math.sin(opts.rotY || 0));
      const ex = (sx * cos + sz * sin) / 2;
      const ez = (sx * sin + sz * cos) / 2;
      this.world.addBox(x - ex, y, z - ez, x + ex, y + sy, z + ez);
      if (opts.nav !== false) this._navFromBox(x - ex, y, z - ez, x + ex, y + sy, z + ez);
    }
    return this;
  }

  cyl(x, y, z, r, h, color, opts = {}) {
    const geo = deindex(new THREE.CylinderGeometry(opts.rTop ?? r, r, h, opts.seg || 10));
    this._bake(geo, x, y + h / 2, z, 0);
    this._paint(geo, color, opts);
    (opts.glow ? this.glow : this.lit).push(geo);
    if (opts.collide !== false) {
      this.world.addBox(x - r, y, z - r, x + r, y + h, z + r);
      if (opts.nav !== false) this._navFromBox(x - r, y, z - r, x + r, y + h, z + r);
    }
    return this;
  }

  cone(x, y, z, r, h, color, opts = {}) {
    return this.cyl(x, y, z, r, h, color, { ...opts, rTop: 0.01, seg: opts.seg || 9 });
  }

  // Squashed icosphere — snow piles, bushes, rocks.
  blob(x, y, z, r, squashY, color, opts = {}) {
    const geo = deindex(new THREE.IcosahedronGeometry(r, 1));
    geo.scale(1, squashY, 1);
    this._bake(geo, x, y + r * squashY * 0.55, z, this.rng() * Math.PI);
    this._paint(geo, color, opts);
    this.lit.push(geo);
    if (opts.collide) {
      const rr = r * 0.8;
      this.world.addBox(x - rr, y, z - rr, x + rr, y + r * squashY, z + rr);
      if (opts.nav !== false) this._navFromBox(x - rr, y, z - rr, x + rr, y + r * squashY, z + rr);
    }
    return this;
  }

  // Flat decorative quad on the ground (rug, pad marker). Never collides.
  mat(x, z, sx, sz, color, opts = {}) {
    const geo = deindex(new THREE.BoxGeometry(sx, 0.04, sz));
    this._bake(geo, x, 0.02, z, opts.rotY || 0);
    this._paint(geo, color, { ...opts, ao: false });
    (opts.glow ? this.glow : this.lit).push(geo);
    return this;
  }

  // Staircase climbing toward +X before rotation. Blocks nav (bots go around).
  stairs(x, y, z, w, rise, run, steps, color, rotY = 0) {
    for (let i = 0; i < steps; i++) {
      const sy = rise * (i + 1);
      const lx = i * run + run / 2 - (steps * run) / 2;
      const wx = x + Math.cos(rotY) * lx;
      const wz = z - Math.sin(rotY) * lx;
      this.box(wx - (Math.cos(rotY) * run) / 2 + (Math.cos(rotY) * run) / 2, y, wz, run + 0.02, sy, w, color, {
        rotY,
        jitter: 0.03,
      });
    }
    return this;
  }

  // Ground plane painted via callback(x, z, outColor).
  ground(half, seg, painter) {
    const geo = deindex(new THREE.PlaneGeometry(half * 2, half * 2, seg, seg));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      painter(pos.getX(i), pos.getZ(i), _c);
      colors[i * 3] = _c.r;
      colors[i * 3 + 1] = _c.g;
      colors[i * 3 + 2] = _c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.lit.push(geo);
    return this;
  }

  // Merge everything into meshes and add to scene. Returns dispose().
  build(scene) {
    const meshes = [];
    if (this.lit.length) {
      const geo = mergeGeometries(this.lit, false);
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      meshes.push(mesh);
      for (const g of this.lit) g.dispose();
    }
    if (this.glow.length) {
      const geo = mergeGeometries(this.glow, false);
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);
      meshes.push(mesh);
      for (const g of this.glow) g.dispose();
    }
    return () => {
      for (const m of meshes) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      }
    };
  }
}
