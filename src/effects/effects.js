// Pooled visual effects. Everything is preallocated + instanced:
//  - ParticlePool: camera-facing quads with per-instance color/alpha/scale
//    (two pools: additive for sparks/flashes, alpha-blend for smoke)
//  - CubeBurst: instanced tumbling cubes (bot shatter, explosion debris)
//  - TracerPool: stretched additive boxes from muzzle to hit
//  - DecalPool: surface-aligned bullet holes / scorch marks
// No allocations at runtime — spawn functions write into ring buffers.

import * as THREE from "three";

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function softCircleTexture(hard = 0.1) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(hard, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function holeTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(30,30,34,0.95)");
  grad.addColorStop(0.5, "rgba(40,38,40,0.8)");
  grad.addColorStop(1, "rgba(40,38,40,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------

class ParticlePool {
  constructor(scene, max, { additive = true, texture = null } = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.col = new Float32Array(max * 3); // sim-side color (render attr is compacted)
    this.head = 0;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.iScale = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.iAlpha = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.iPos.setUsage(THREE.DynamicDrawUsage);
    this.iScale.setUsage(THREE.DynamicDrawUsage);
    this.iAlpha.setUsage(THREE.DynamicDrawUsage);
    this.iColor.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iPos", this.iPos);
    geo.setAttribute("iScale", this.iScale);
    geo.setAttribute("iAlpha", this.iAlpha);
    geo.setAttribute("iColor", this.iColor);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        map: { value: texture || softCircleTexture() },
        camRight: { value: new THREE.Vector3(1, 0, 0) },
        camUp: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute float iScale;
        attribute float iAlpha;
        attribute vec3 iColor;
        uniform vec3 camRight, camUp;
        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vAlpha = iAlpha;
          vColor = iColor;
          vec3 wp = iPos + camRight * position.x * iScale + camUp * position.y * iScale;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(map, vUv);
          gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
          if (gl_FragColor.a < 0.003) discard;
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    geo.instanceCount = 0;
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a0, grav = 0, drag = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = a0;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
  }

  update(dt, camera) {
    const m = this.mesh.material.uniforms;
    m.camRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
    m.camUp.value.setFromMatrixColumn(camera.matrixWorld, 1);

    let count = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const k = 1 - this.life[i] / this.maxLife[i];
      const dr = 1 - this.drag[i] * dt;
      this.vel[i * 3] *= dr;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= dr;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;

      this.iPos.array[count * 3] = this.pos[i * 3];
      this.iPos.array[count * 3 + 1] = this.pos[i * 3 + 1];
      this.iPos.array[count * 3 + 2] = this.pos[i * 3 + 2];
      this.iScale.array[count] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      this.iAlpha.array[count] = this.a0[i] * (1 - k);
      this.iColor.array[count * 3] = this.col[i * 3];
      this.iColor.array[count * 3 + 1] = this.col[i * 3 + 1];
      this.iColor.array[count * 3 + 2] = this.col[i * 3 + 2];
      count++;
    }
    this.mesh.geometry.instanceCount = count;
    if (count > 0) {
      this.iPos.needsUpdate = true;
      this.iScale.needsUpdate = true;
      this.iAlpha.needsUpdate = true;
      this.iColor.needsUpdate = true;
    }
  }

  clear() {
    this.life.fill(0);
    this.mesh.geometry.instanceCount = 0;
  }
}

// ---------------------------------------------------------------------------

class CubeBurst {
  constructor(scene, max) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      max
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.rot = new Float32Array(max * 3);
    this.angV = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.head = 0;
    this._e = new THREE.Euler();
  }

  spawn(x, y, z, vx, vy, vz, size, life, color) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.rot.set([Math.random() * 3, Math.random() * 3, Math.random() * 3], i * 3);
    this.angV.set([(Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12], i * 3);
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    _c.set(color);
    this.col[i * 3] = _c.r;
    this.col[i * 3 + 1] = _c.g;
    this.col[i * 3 + 2] = _c.b;
  }

  update(dt) {
    let count = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;

      this.vel[i * 3 + 1] -= 16 * dt;
      let y = this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt;
      const half = this.size[i] / 2;
      if (y < half) {
        y = half;
        this.vel[i * 3 + 1] *= -0.35;
        this.vel[i * 3] *= 0.7;
        this.vel[i * 3 + 2] *= 0.7;
        this.angV[i * 3] *= 0.6;
        this.angV[i * 3 + 2] *= 0.6;
      }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.rot[i * 3] += this.angV[i * 3] * dt;
      this.rot[i * 3 + 1] += this.angV[i * 3 + 1] * dt;
      this.rot[i * 3 + 2] += this.angV[i * 3 + 2] * dt;

      const k = this.life[i] / this.maxLife[i];
      const sc = this.size[i] * (k < 0.25 ? k / 0.25 : 1);
      this._e.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2]);
      _q.setFromEuler(this._e);
      _s.setScalar(Math.max(sc, 0.001));
      _v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      _m.compose(_v, _q, _s);
      this.mesh.setMatrixAt(count, _m);
      this.mesh.instanceColor.setXYZ(count, this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]);
      count++;
    }
    this.mesh.count = count;
    if (count) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear() {
    this.life.fill(0);
    this.mesh.count = 0;
  }
}

// ---------------------------------------------------------------------------

class TracerPool {
  constructor(scene, max) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.85,
      }),
      max
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.data = [];
    for (let i = 0; i < max; i++) {
      this.data.push({ sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0, life: 0, maxLife: 1, r: 1, g: 1, b: 1 });
    }
    this.head = 0;
  }

  spawn(sx, sy, sz, ex, ey, ez, color) {
    const d = this.data[this.head];
    _c.set(color);
    d.r = _c.r; d.g = _c.g; d.b = _c.b;
    this.head = (this.head + 1) % this.max;
    d.sx = sx; d.sy = sy; d.sz = sz;
    d.ex = ex; d.ey = ey; d.ez = ez;
    d.life = d.maxLife = 0.075;
  }

  update(dt) {
    let count = 0;
    for (let i = 0; i < this.max; i++) {
      const d = this.data[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) continue;
      const k = d.life / d.maxLife;
      const dx = d.ex - d.sx, dy = d.ey - d.sy, dz = d.ez - d.sz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 0.05) continue;
      _v.set(d.sx + dx / 2, d.sy + dy / 2, d.sz + dz / 2);
      _s.set(0.024 * k + 0.004, 0.024 * k + 0.004, len);
      _q.setFromUnitVectors(Z_AXIS, _dirNorm.set(dx / len, dy / len, dz / len));
      _m.compose(_v, _q, _s);
      this.mesh.setMatrixAt(count, _m);
      this.mesh.instanceColor.setXYZ(count, d.r, d.g, d.b);
      count++;
    }
    this.mesh.count = count;
    if (count) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear() {
    for (const d of this.data) d.life = 0;
    this.mesh.count = 0;
  }
}

const _dirNorm = new THREE.Vector3();

// ---------------------------------------------------------------------------

class DecalPool {
  constructor(scene, max) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: holeTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
      max
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.life = new Float32Array(max);
    this.mats = [];
    for (let i = 0; i < max; i++) this.mats.push(new THREE.Matrix4());
    this.sizes = new Float32Array(max);
    this.head = 0;
  }

  spawn(px, py, pz, nx, ny, nz, size) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.life[i] = 14;
    this.sizes[i] = size;
    _v.set(px + nx * 0.012, py + ny * 0.012, pz + nz * 0.012);
    _dirNorm.set(nx, ny, nz);
    _q.setFromUnitVectors(Z_AXIS, _dirNorm);
    _s.setScalar(size);
    this.mats[i].compose(_v, _q, _s);
  }

  update(dt) {
    let count = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const m = this.mats[i];
      if (this.life[i] < 1) {
        // shrink out at end of life
        const k = Math.max(this.life[i], 0.0001);
        _m.copy(m);
        _m.elements[0] *= k; _m.elements[1] *= k; _m.elements[2] *= k;
        _m.elements[4] *= k; _m.elements[5] *= k; _m.elements[6] *= k;
        this.mesh.setMatrixAt(count, _m);
      } else {
        this.mesh.setMatrixAt(count, m);
      }
      count++;
    }
    this.mesh.count = count;
    if (count) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.mesh.count = 0;
  }
}

// ---------------------------------------------------------------------------
// facade
// ---------------------------------------------------------------------------

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.sparks = new ParticlePool(scene, 320, { additive: true });
    this.smoke = new ParticlePool(scene, 200, { additive: false, texture: softCircleTexture(0.02) });
    this.cubes = new CubeBurst(scene, 220);
    this.tracers = new TracerPool(scene, 48);
    this.decals = new DecalPool(scene, 110);
  }

  tracer(sx, sy, sz, ex, ey, ez, color) {
    this.tracers.spawn(sx, sy, sz, ex, ey, ez, color);
  }

  impact(px, py, pz, nx, ny, nz) {
    this.decals.spawn(px, py, pz, nx, ny, nz, 0.09 + Math.random() * 0.05);
    for (let i = 0; i < 6; i++) {
      const vx = nx * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2.4;
      const vy = ny * (1.5 + Math.random() * 2.5) + Math.random() * 2.2;
      const vz = nz * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2.4;
      this.sparks.spawn(px, py, pz, vx, vy, vz, 0.16 + Math.random() * 0.14, 0.05, 0.012, 1, 0.85, 0.5, 0.9, 9, 2);
    }
    this.smoke.spawn(px + nx * 0.05, py + ny * 0.05, pz + nz * 0.05, nx * 0.5, 0.4, nz * 0.5, 0.5, 0.1, 0.42, 0.62, 0.6, 0.56, 0.35, 0, 0.5);
  }

  hitSpark(px, py, pz, headshot) {
    const n = headshot ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 3.2;
      this.sparks.spawn(
        px, py, pz,
        Math.cos(a) * (1.2 + Math.random() * 2), up, Math.sin(a) * (1.2 + Math.random() * 2),
        0.2 + Math.random() * 0.15,
        headshot ? 0.075 : 0.05, 0.014,
        headshot ? 1 : 0.55, headshot ? 0.82 : 0.95, headshot ? 0.3 : 1,
        0.95, 10, 2
      );
    }
  }

  shieldSpark(px, py, pz) {
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.spawn(px, py, pz, Math.cos(a) * 2, Math.random() * 2.5, Math.sin(a) * 2, 0.18, 0.05, 0.01, 0.45, 0.85, 1, 0.9, 8, 2);
    }
  }

  shatter(px, py, pz, colorA, colorB) {
    for (let i = 0; i < 17; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 4.5;
      this.cubes.spawn(
        px + (Math.random() - 0.5) * 0.5,
        py + Math.random() * 1.4,
        pz + (Math.random() - 0.5) * 0.5,
        Math.cos(a) * sp, 2 + Math.random() * 4.5, Math.sin(a) * sp,
        0.09 + Math.random() * 0.13,
        0.8 + Math.random() * 0.5,
        i % 3 === 0 ? colorB : colorA
      );
    }
    for (let i = 0; i < 5; i++) {
      this.sparks.spawn(px, py + 1, pz, (Math.random() - 0.5) * 4, Math.random() * 4, (Math.random() - 0.5) * 4, 0.25, 0.09, 0.02, 0.6, 0.95, 1, 0.9, 6, 2);
    }
  }

  explosion(px, py, pz) {
    // core flash
    this.sparks.spawn(px, py + 0.4, pz, 0, 0, 0, 0.16, 1.4, 4.6, 1, 0.92, 0.6, 1, 0, 0);
    this.sparks.spawn(px, py + 0.4, pz, 0, 0, 0, 0.3, 0.7, 3.2, 1, 0.6, 0.25, 0.9, 0, 0);
    // sparks out
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = Math.random() * Math.PI * 0.5;
      const sp = 6 + Math.random() * 9;
      this.sparks.spawn(
        px, py + 0.3, pz,
        Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp,
        0.3 + Math.random() * 0.3, 0.09, 0.015, 1, 0.75, 0.35, 1, 11, 1.6
      );
    }
    // debris
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 6;
      this.cubes.spawn(px, py + 0.4, pz, Math.cos(a) * sp, 3 + Math.random() * 6, Math.sin(a) * sp, 0.1 + Math.random() * 0.12, 0.9 + Math.random() * 0.4, i % 2 ? "#5c5650" : "#8a8078");
    }
    // smoke
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      this.smoke.spawn(
        px + Math.cos(a) * 0.5, py + 0.4 + Math.random() * 0.5, pz + Math.sin(a) * 0.5,
        Math.cos(a) * 1.6, 1.6 + Math.random() * 1.2, Math.sin(a) * 1.6,
        1.1 + Math.random() * 0.5, 0.7, 2.6, 0.62, 0.58, 0.54, 0.5, -0.4, 1.4
      );
    }
    this.decals.spawn(px, Math.max(py - 0.3, 0.01), pz, 0, 1, 0, 2.6);
  }

  rocketTrail(px, py, pz) {
    this.smoke.spawn(px, py, pz, (Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.3, 0.16, 0.6, 0.82, 0.8, 0.76, 0.42, -0.2, 1);
    this.sparks.spawn(px, py, pz, 0, 0, 0, 0.08, 0.14, 0.02, 1, 0.7, 0.3, 0.9, 0, 0);
  }

  spawnBeamFx(px, pz) {
    for (let i = 0; i < 8; i++) {
      this.sparks.spawn(px + (Math.random() - 0.5) * 0.8, 0.1 + Math.random() * 2.4, pz + (Math.random() - 0.5) * 0.8, 0, 1.5 + Math.random(), 0, 0.5, 0.06, 0.01, 0.98, 0.55, 0.35, 0.9, -1.5, 0);
    }
  }

  update(dt, camera) {
    this.sparks.update(dt, camera);
    this.smoke.update(dt, camera);
    this.cubes.update(dt);
    this.tracers.update(dt);
    this.decals.update(dt);
  }

  clear() {
    this.sparks.clear();
    this.smoke.clear();
    this.cubes.clear();
    this.tracers.clear();
    this.decals.clear();
  }
}
