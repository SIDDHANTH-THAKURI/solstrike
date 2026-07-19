// Multiplayer client: NetClient (websocket + message routing) and
// RemoteManager (remote player avatars with snapshot interpolation and the
// same raycast interface Combat uses for bots, so hitscan/splash/ult work
// against live opponents unchanged).

import * as THREE from "three";
import { audio } from "../core/audio.js";
import { clamp } from "../core/utils.js";

const INTERP_MS = 130; // render remotes this far in the past → smooth over jitter

export function defaultServerUrl() {
  const saved = localStorage.getItem("sol-server");
  if (saved) return saved;
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  // vite dev serves on 5173; the game server (ws + built client) is 8081.
  // Any other origin: the game server itself is serving us — same origin.
  if (location.port === "5173") return proto + location.hostname + ":8081";
  return proto + location.host;
}

export class NetClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.open = false;
    this.handlers = {}; // t -> fn(msg)
    this.onClose = null;
    this.onOpen = null;
    this._timeOffset = 0; // serverTime - performance.now(), EMA
    this._hasOffset = false;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.open = true;
      if (this.onOpen) this.onOpen();
    };
    this.ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "snap") {
        const off = m.time - performance.now();
        this._timeOffset = this._hasOffset ? this._timeOffset * 0.95 + off * 0.05 : off;
        this._hasOffset = true;
      }
      if (m.t === "joined") this.id = m.id;
      const h = this.handlers[m.t];
      if (h) h(m);
    };
    this.ws.onclose = () => {
      this.open = false;
      if (this.onClose) this.onClose();
    };
    this.ws.onerror = () => {};
  }

  on(t, fn) {
    this.handlers[t] = fn;
  }

  send(obj) {
    if (this.open && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // server clock mapped to local performance.now() axis
  serverNow() {
    return performance.now() + this._timeOffset;
  }

  close() {
    this.onClose = null;
    try {
      this.ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------- remotes

const PALETTE = ["#e5484d", "#8250df", "#0969da", "#bf3989", "#bc4c00", "#1a7f37", "#d4a72c", "#57606a"];
const _o = new THREE.Vector3();

function makeNameSprite(name, color) {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.font = "700 34px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "rgba(30,30,40,0.85)";
  ctx.lineWidth = 6;
  ctx.strokeText(name, 128, 32);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.7, 0.42, 1);
  return sp;
}

// shared suit materials (skipped by deepDispose via userData.shared)
let _suitMat = null, _suitDarkMat = null, _shellMat = null, _visorMat = null;
function avatarMats() {
  if (!_suitMat) {
    _suitMat = new THREE.MeshLambertMaterial({ color: "#57616e" });
    _suitDarkMat = new THREE.MeshLambertMaterial({ color: "#333b46" });
    _shellMat = new THREE.MeshLambertMaterial({ color: "#e9edf2" });
    _visorMat = new THREE.MeshBasicMaterial({ color: "#141a22" });
    for (const m of [_suitMat, _suitDarkMat, _shellMat, _visorMat]) m.userData.shared = true;
  }
  return { suit: _suitMat, dark: _suitDarkMat, shell: _shellMat, visor: _visorMat };
}

function part(parent, geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

class RemoteAvatar {
  constructor(scene, id, name) {
    this.id = id;
    this.name = name;
    this.alive = true;
    this.state = "alive"; // Combat checks !== "dead"
    this.hp = 100;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.crouchV = 0;
    this.cfg = { accent: PALETTE[id % PALETTE.length] };
    this.buf = []; // snapshot ring: {t,x,y,z,yaw,pitch,cr,anim}
    this._walkPhase = 0;
    this._moveK = 0; // damped 0..1 walk-cycle weight
    this._t = Math.random() * 10; // idle-breath phase offset per player

    const { suit, dark, shell, visor } = avatarMats();
    const accent = new THREE.MeshLambertMaterial({ color: this.cfg.accent });
    const glow = new THREE.MeshBasicMaterial({ color: this.cfg.accent });
    const g = new THREE.Group();

    // legs pivot at the hip so the swing reads like a stride, not a shear
    const buildLeg = (sx) => {
      const hip = new THREE.Group();
      hip.position.set(sx, 0.9, 0);
      part(hip, new THREE.CapsuleGeometry(0.08, 0.6, 4, 10), suit, 0, -0.34, 0);
      part(hip, new THREE.SphereGeometry(0.075, 10, 8), shell, 0, -0.36, -0.045); // knee pad
      part(hip, new THREE.BoxGeometry(0.15, 0.1, 0.25), dark, 0, -0.85, -0.04);
      g.add(hip);
      return hip;
    };
    this.legL = buildLeg(-0.115);
    this.legR = buildLeg(0.115);

    // everything above the hips sinks together on crouch
    const up = new THREE.Group();
    g.add(up);
    this.upper = up;

    part(up, new THREE.CylinderGeometry(0.16, 0.175, 0.18, 12), dark, 0, 0.98, 0);
    part(up, new THREE.CylinderGeometry(0.175, 0.175, 0.05, 12), accent, 0, 1.05, 0); // belt
    const chest = part(up, new THREE.CapsuleGeometry(0.205, 0.3, 4, 12), accent, 0, 1.22, 0);
    chest.scale.z = 0.78;
    // chest core light (front is -Z)
    const core = part(up, new THREE.CylinderGeometry(0.05, 0.05, 0.03, 10), glow, 0, 1.27, -0.155);
    core.rotation.x = Math.PI / 2;
    // backpack + tanks
    part(up, new THREE.BoxGeometry(0.3, 0.32, 0.13), dark, 0, 1.24, 0.19);
    part(up, new THREE.CylinderGeometry(0.045, 0.045, 0.26, 8), suit, -0.09, 1.26, 0.26);
    part(up, new THREE.CylinderGeometry(0.045, 0.045, 0.26, 8), suit, 0.09, 1.26, 0.26);
    // shoulder balls
    part(up, new THREE.SphereGeometry(0.1, 12, 8), shell, -0.27, 1.38, 0);
    part(up, new THREE.SphereGeometry(0.1, 12, 8), shell, 0.27, 1.38, 0);

    // left arm swings with the stride
    this.armL = new THREE.Group();
    this.armL.position.set(-0.28, 1.36, 0);
    part(this.armL, new THREE.CapsuleGeometry(0.06, 0.42, 4, 8), suit, 0, -0.24, 0);
    part(this.armL, new THREE.SphereGeometry(0.065, 10, 8), dark, 0, -0.5, 0);
    up.add(this.armL);

    // right arm holds the rifle and pitches with aim
    this.armR = new THREE.Group();
    this.armR.position.set(0.28, 1.36, 0);
    part(this.armR, new THREE.CapsuleGeometry(0.06, 0.18, 4, 8), suit, 0, -0.12, -0.02);
    const forearm = part(this.armR, new THREE.CapsuleGeometry(0.055, 0.22, 4, 8), suit, 0, -0.26, -0.17);
    forearm.rotation.x = Math.PI / 2;
    part(this.armR, new THREE.SphereGeometry(0.06, 10, 8), dark, 0, -0.26, -0.31);
    const gun = new THREE.Group();
    gun.position.set(0, -0.26, -0.3);
    part(gun, new THREE.BoxGeometry(0.07, 0.11, 0.4), dark, 0, 0, -0.05);
    const barrel = part(gun, new THREE.CylinderGeometry(0.025, 0.025, 0.24, 10), shell, 0, 0.015, -0.34);
    barrel.rotation.x = Math.PI / 2;
    part(gun, new THREE.SphereGeometry(0.02, 8, 6), glow, 0, 0.015, -0.47);
    part(gun, new THREE.BoxGeometry(0.05, 0.12, 0.08), suit, 0, -0.1, 0.03);
    part(gun, new THREE.BoxGeometry(0.06, 0.09, 0.12), suit, 0, -0.015, 0.18);
    this.armR.add(gun);
    up.add(this.armR);

    // helmet head: shell sphere, dark visor band, accent crest + antenna
    this.head = new THREE.Group();
    this.head.position.set(0, 1.6, 0);
    const dome = part(this.head, new THREE.SphereGeometry(0.185, 16, 12), shell, 0, 0.02, 0);
    dome.scale.set(1, 1.05, 1.02);
    const glass = part(this.head, new THREE.SphereGeometry(0.16, 14, 10), visor, 0, 0.01, -0.07);
    glass.scale.set(1, 0.62, 0.82);
    part(this.head, new THREE.BoxGeometry(0.03, 0.02, 0.3), glow, 0, 0.21, 0);
    part(this.head, new THREE.CylinderGeometry(0.05, 0.05, 0.04, 10), dark, -0.185, 0.01, 0).rotation.z = Math.PI / 2;
    part(this.head, new THREE.CylinderGeometry(0.05, 0.05, 0.04, 10), dark, 0.185, 0.01, 0).rotation.z = Math.PI / 2;
    part(this.head, new THREE.CylinderGeometry(0.008, 0.008, 0.16, 6), dark, 0.17, 0.18, 0.05);
    part(this.head, new THREE.SphereGeometry(0.02, 8, 6), glow, 0.17, 0.27, 0.05);
    up.add(this.head);

    this.tag = makeNameSprite(name, this.cfg.accent);
    this.tag.position.y = 2.08;
    g.add(this.tag);

    g.visible = false;
    scene.add(g);
    this.group = g;
  }

  push(t, x, y, z, yaw, pitch, cr, anim) {
    const b = this.buf;
    b.push({ t, x, y, z, yaw, pitch, cr, anim });
    while (b.length > 30) b.shift();
  }

  // interpolate to time T, animate
  tick(renderT, dt) {
    const b = this.buf;
    if (b.length === 0) return;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > renderT) i--;
    const b1 = b[i];
    const b0 = i > 0 ? b[i - 1] : b1;
    const span = b1.t - b0.t;
    const k = span > 0 ? clamp((renderT - b0.t) / span, 0, 1.25) : 1; // slight extrapolation
    const lerp = (a, c) => a + (c - a) * k;
    this.x = lerp(b0.x, b1.x);
    this.y = lerp(b0.y, b1.y);
    this.z = lerp(b0.z, b1.z);
    let dy = b1.yaw - b0.yaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw = b0.yaw + dy * k;
    this.pitch = lerp(b0.pitch, b1.pitch);
    this.crouchV = lerp(b0.cr, b1.cr);

    const g = this.group;
    g.position.set(this.x, this.y, this.z);
    g.rotation.y = this.yaw;
    g.visible = this.alive;
    this._t += dt;

    // walk cycle weight eases in/out so stops don't freeze mid-stride
    const moving = b1.anim & 1;
    this._moveK += ((moving ? 1 : 0) - this._moveK) * Math.min(1, dt * 10);
    const wk = this._moveK;
    this._walkPhase += dt * 11 * wk;
    const sw = Math.sin(this._walkPhase) * 0.55 * wk;
    this.legL.rotation.x = sw;
    this.legR.rotation.x = -sw;
    this.armL.rotation.x = -sw * 0.6;

    // crouch sink + run bob + idle breath, all on the upper body group
    const sink = this.crouchV * 0.42;
    this.upper.position.y = -sink - Math.abs(Math.cos(this._walkPhase)) * 0.025 * wk + Math.sin(this._t * 1.8) * 0.006 * (1 - wk);
    this.upper.rotation.x = 0.06 * wk; // slight forward lean at speed
    this.armR.rotation.x = this.pitch * 0.85;
    this.head.rotation.x = this.pitch * 0.55;
  }

  headPos() {
    return { x: this.x, y: this.y + 1.62 - this.crouchV * 0.42, z: this.z };
  }

  muzzlePos(out) {
    out.set(0.28, 1.1 - this.crouchV * 0.42, -0.77);
    out.applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw);
    out.x += this.x;
    out.y += this.y;
    out.z += this.z;
    return out;
  }

  // Combat interface — local damage prediction; server is authoritative
  damage(dmg, _part) {
    this.hp -= dmg;
    return this.hp <= 0;
  }

  kill() {
    this.alive = false;
    this.state = "dead";
    this.group.visible = false;
  }

  respawn(x, z) {
    this.alive = true;
    this.state = "alive";
    this.hp = 100;
    this.buf.length = 0;
    this.x = x;
    this.z = z;
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (!o.material.userData.shared) o.material.dispose();
      }
    });
    this.tag.material.map.dispose();
    this.tag.material.dispose();
  }
}

export class RemoteManager {
  constructor(scene, effects) {
    this.scene = scene;
    this.effects = effects;
    this.map = new Map(); // id -> RemoteAvatar
    this.bots = []; // Combat iterates this for splash/ult
  }

  add(id, name) {
    if (this.map.has(id)) return this.map.get(id);
    const a = new RemoteAvatar(this.scene, id, name);
    this.map.set(id, a);
    this.bots = [...this.map.values()];
    return a;
  }

  remove(id) {
    const a = this.map.get(id);
    if (!a) return;
    a.dispose(this.scene);
    this.map.delete(id);
    this.bots = [...this.map.values()];
  }

  get(id) {
    return this.map.get(id);
  }

  get aliveCount() {
    let n = 0;
    for (const a of this.map.values()) if (a.alive) n++;
    return n;
  }

  applySnap(msg, myId) {
    for (const row of msg.p) {
      if (row[0] === myId) continue;
      const a = this.map.get(row[0]);
      if (!a) continue;
      a.push(msg.time, row[1], row[2], row[3], row[4], row[5], row[6], row[7]);
      a.hp = row[9]; // server-authoritative hp keeps local prediction honest
      if (row[9] > 0 && !a.alive) {
        // missed a spawn msg — recover
        a.alive = true;
        a.state = "alive";
      }
    }
  }

  update(dt, renderT) {
    for (const a of this.map.values()) a.tick(renderT, dt);
  }

  // remote fired: tracer from their muzzle + positional shot sound
  remoteFire(id, w, d, statics) {
    const a = this.map.get(id);
    if (!a || !a.alive) return;
    a.muzzlePos(_o);
    audio.shot(w, _o);
    if (!Array.isArray(d) || d.length < 6) return;
    let t = 90;
    const hit = {};
    if (statics.raycast(d[0], d[1], d[2], d[3], d[4], d[5], 90, hit)) t = hit.t;
    this.effects.tracer(_o.x, _o.y, _o.z, d[0] + d[3] * t, d[1] + d[4] * t, d[2] + d[5] * t, "#ffb36b");
    if (hit.t) this.effects.impact(d[0] + d[3] * t, d[1] + d[4] * t, d[2] + d[5] * t, hit.nx, hit.ny, hit.nz);
  }

  // Combat's bot-raycast contract: nearest hit within maxT → {t, part, bot}
  raycast(ox, oy, oz, dx, dy, dz, maxT, out) {
    let best = null;
    for (const a of this.map.values()) {
      if (!a.alive) continue;
      // head sphere
      const h = a.headPos();
      const tH = raySphere(ox, oy, oz, dx, dy, dz, h.x, h.y, h.z, 0.24);
      if (tH !== null && tH < maxT && (!best || tH < best.t)) best = { t: tH, part: "head", bot: a };
      // body cylinder
      const y0 = a.y + 0.05;
      const y1 = a.y + 1.5 - a.crouchV * 0.4;
      const tB = rayCylinder(ox, oy, oz, dx, dy, dz, a.x, a.z, 0.34, y0, y1);
      if (tB !== null && tB < maxT && (!best || tB < best.t)) best = { t: tB, part: "body", bot: a };
    }
    if (best && out) {
      out.t = best.t;
      out.part = best.part;
      out.bot = best.bot;
      return out;
    }
    return best;
  }

  dispose() {
    for (const a of this.map.values()) a.dispose(this.scene);
    this.map.clear();
    this.bots = [];
  }
}

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return null;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return null;
  return tca - Math.sqrt(r * r - d2);
}

function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, r, y0, y1) {
  // vertical cylinder: solve in XZ
  const fx = ox - cx, fz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-8) {
    // straight up/down
    if (fx * fx + fz * fz > r * r) return null;
    const t = dy > 0 ? (y0 - oy) / dy : (y1 - oy) / dy;
    return t > 0 ? t : null;
  }
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0) return null;
  const y = oy + dy * t;
  if (y < y0 || y > y1) {
    // try cap planes
    const tCap = dy !== 0 ? ((dy > 0 ? y0 : y1) - oy) / dy : -1;
    if (tCap > 0) {
      const px = ox + dx * tCap - cx, pz = oz + dz * tCap - cz;
      if (px * px + pz * pz <= r * r) return tCap;
    }
    return null;
  }
  return t;
}
