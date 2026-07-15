// Spectre combat bots. Hierarchical low-poly robots (no skinning), pooled
// and reused across rounds. AI: spawn beam-in → hunt via A* → strafing
// combat with telegraphed burst fire. LOS raycasts are throttled and
// staggered across bots.

import * as THREE from "three";
import { clamp, damp, angleLerp } from "../core/utils.js";
import { audio } from "../core/audio.js";

const CHASSIS = "#606c78";
const JOINT = "#414b55";
const ACCENT = "#e5484d";
const EYE_HEIGHT = 1.58;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hit = {};

let _chassisMat = null;
let _jointMat = null;
function sharedMats() {
  if (!_chassisMat) {
    _chassisMat = new THREE.MeshLambertMaterial({ color: CHASSIS });
    _chassisMat.userData.shared = true;
    _jointMat = new THREE.MeshLambertMaterial({ color: JOINT });
    _jointMat.userData.shared = true;
  }
  return { chassis: _chassisMat, joint: _jointMat };
}

function bx(parent, x, y, z, sx, sy, sz, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

class Bot {
  constructor(scene) {
    const { chassis, joint } = sharedMats();
    // per-bot accent material so the visor can telegraph
    this.accentMat = new THREE.MeshBasicMaterial({ color: ACCENT });

    this.root = new THREE.Group();
    scene.add(this.root);

    // legs
    this.legL = new THREE.Group();
    this.legL.position.set(-0.13, 0.92, 0);
    bx(this.legL, 0, -0.24, 0, 0.13, 0.48, 0.14, joint);
    bx(this.legL, 0, -0.52, 0.02, 0.15, 0.12, 0.22, chassis); // foot
    this.root.add(this.legL);
    this.legR = new THREE.Group();
    this.legR.position.set(0.13, 0.92, 0);
    bx(this.legR, 0, -0.24, 0, 0.13, 0.48, 0.14, joint);
    bx(this.legR, 0, -0.52, 0.02, 0.15, 0.12, 0.22, chassis);
    this.root.add(this.legR);

    // torso (aims at player)
    this.torso = new THREE.Group();
    this.torso.position.set(0, 1.02, 0);
    this.root.add(this.torso);
    bx(this.torso, 0, 0.26, 0, 0.44, 0.46, 0.26, chassis);
    bx(this.torso, 0, 0.0, 0, 0.34, 0.14, 0.22, joint); // waist
    bx(this.torso, 0, 0.3, 0.145, 0.2, 0.12, 0.02, this.accentMat); // chest light
    bx(this.torso, 0, 0.34, -0.17, 0.3, 0.3, 0.1, joint); // backpack
    // shoulders
    bx(this.torso, -0.28, 0.42, 0, 0.14, 0.14, 0.18, this.accentMat);
    bx(this.torso, 0.28, 0.42, 0, 0.14, 0.14, 0.18, this.accentMat);

    // left arm (swings)
    this.armL = new THREE.Group();
    this.armL.position.set(-0.31, 0.4, 0);
    bx(this.armL, 0, -0.22, 0, 0.11, 0.42, 0.12, joint);
    this.torso.add(this.armL);

    // right arm holds blaster, pitches to aim
    this.armR = new THREE.Group();
    this.armR.position.set(0.31, 0.4, 0);
    bx(this.armR, 0, -0.1, -0.08, 0.11, 0.24, 0.12, joint);
    const gun = new THREE.Group();
    gun.position.set(0, -0.2, -0.18);
    bx(gun, 0, 0, 0, 0.08, 0.11, 0.34, joint);
    bx(gun, 0, 0.02, -0.22, 0.05, 0.05, 0.14, chassis);
    bx(gun, 0, -0.02, -0.29, 0.03, 0.03, 0.03, this.accentMat); // glow tip
    this.armR.add(gun);
    this.torso.add(this.armR);

    // head
    this.head = new THREE.Group();
    this.head.position.set(0, 0.62, 0);
    bx(this.head, 0, 0.11, 0, 0.26, 0.24, 0.26, chassis);
    bx(this.head, 0, 0.11, 0.135, 0.2, 0.07, 0.02, this.accentMat); // visor
    bx(this.head, 0.09, 0.3, 0, 0.02, 0.14, 0.02, joint); // antenna
    bx(this.head, 0.09, 0.38, 0, 0.045, 0.045, 0.045, this.accentMat);
    this.torso.add(this.head);

    this.root.visible = false;

    // state
    this.alive = false;
    this.state = "idle";
    this.hp = 100;
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.cfg = null;
    this._path = [];
    this._pathIdx = 0;
    this._repathT = 0;
    this._losT = 0;
    this._seesPlayer = false;
    this._walkPhase = 0;
    this._strafeDir = 1;
    this._strafeT = 0;
    this._fire = { windup: 0, burst: 0, interval: 0, cooldown: 1 };
    this._flinch = 0;
    this._spawnT = 0;
    this._moveSpeed = 0;
    this._stepT = 0;
  }

  spawn(x, z, cfg, stagger) {
    this.alive = true;
    this.state = "spawning";
    this.cfg = cfg;
    this.hp = cfg.hp;
    this.x = x;
    this.z = z;
    this.yaw = Math.atan2(-x, -z);
    this._spawnT = 0.85;
    this._losT = stagger * 0.05;
    this._repathT = 0;
    this._path.length = 0;
    this._fire.cooldown = 1 + stagger * 0.3;
    this._fire.windup = 0;
    this._fire.burst = 0;
    this.accentMat.color.set(cfg.accent || ACCENT);
    this.root.visible = true;
    this.root.scale.set(1, 0.01, 1);
    this.root.position.set(x, 0, z);
  }

  kill(fromExplosion) {
    if (!this.alive) return;
    this.alive = false;
    this.state = "dead";
    this.root.visible = false;
  }

  // ray vs head sphere + body box. Returns t or -1; part written to _hitPart.
  testRay(ox, oy, oz, dx, dy, dz, maxD) {
    // body AABB (generous, yaw-independent)
    const x0 = this.x - 0.3, x1 = this.x + 0.3;
    const y0 = 0.1, y1 = 1.48;
    const z0 = this.z - 0.3, z1 = this.z + 0.3;
    let tmin = -1;
    let part = "body";

    const idx = dx !== 0 ? 1 / dx : 1e30;
    const idy = dy !== 0 ? 1 / dy : 1e30;
    const idz = dz !== 0 ? 1 / dz : 1e30;
    let t1 = (x0 - ox) * idx, t2 = (x1 - ox) * idx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    let lo = t1, hi = t2;
    t1 = (y0 - oy) * idy; t2 = (y1 - oy) * idy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    lo = Math.max(lo, t1); hi = Math.min(hi, t2);
    t1 = (z0 - oz) * idz; t2 = (z1 - oz) * idz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    lo = Math.max(lo, t1); hi = Math.min(hi, t2);
    if (lo <= hi && lo > 0 && lo < maxD) tmin = lo;

    // head sphere
    const hx = this.x, hy = EYE_HEIGHT + 0.06, hz = this.z, r = 0.19;
    const lx = hx - ox, ly = hy - oy, lz = hz - oz;
    const tc = lx * dx + ly * dy + lz * dz;
    if (tc > 0 && tc < maxD) {
      const d2 = lx * lx + ly * ly + lz * lz - tc * tc;
      if (d2 < r * r) {
        const t = tc - Math.sqrt(r * r - d2);
        if (t > 0 && (tmin < 0 || t < tmin + 0.35)) {
          // head takes priority when the ray passes through it
          tmin = t;
          part = "head";
        }
      }
    }
    _hitPartCache = part;
    return tmin;
  }

  damage(amount, part) {
    if (!this.alive || this.state === "dead") return false;
    this.hp -= amount;
    this._flinch = Math.min(this._flinch + 0.5, 1);
    return this.hp <= 0;
  }

  update(dt, ctx) {
    if (!this.alive) return;
    const cfg = this.cfg;

    if (this.state === "spawning") {
      this._spawnT -= dt;
      const k = clamp(1 - this._spawnT / 0.85, 0, 1);
      this.root.scale.set(1, 0.01 + 0.99 * (k * k), 1);
      this.root.position.set(this.x, 0, this.z);
      if (this._spawnT <= 0) {
        this.root.scale.set(1, 1, 1);
        this.state = "hunt";
      }
      return;
    }

    const px = ctx.player.x, pz = ctx.player.z;
    const dxp = px - this.x, dzp = pz - this.z;
    const distP = Math.sqrt(dxp * dxp + dzp * dzp);

    // throttled LOS
    this._losT -= dt;
    if (this._losT <= 0) {
      this._losT = 0.16;
      this._seesPlayer =
        distP < cfg.engageRange &&
        !ctx.statics.losBlocked(this.x, EYE_HEIGHT, this.z, px, ctx.player.eyeY, pz);
    }

    const inCombat = this._seesPlayer && distP < cfg.engageRange;
    this.state = inCombat ? "combat" : "hunt";

    let moveX = 0, moveZ = 0;
    let wantSpeed = 0;

    if (this.state === "hunt") {
      // follow path to player
      this._repathT -= dt;
      if (this._repathT <= 0 || this._pathIdx >= this._path.length / 2) {
        this._repathT = 0.8 + Math.random() * 0.4;
        ctx.nav.findPath(this.x, this.z, px, pz, this._path);
        this._pathIdx = 0;
      }
      if (this._path.length >= 2 && this._pathIdx < this._path.length / 2) {
        const wx = this._path[this._pathIdx * 2];
        const wz = this._path[this._pathIdx * 2 + 1];
        const dx = wx - this.x, dz = wz - this.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 0.5) {
          this._pathIdx++;
        } else {
          moveX = dx / d;
          moveZ = dz / d;
          wantSpeed = cfg.speed;
          this.yaw = angleLerp(this.yaw, Math.atan2(-dx, -dz), 1 - Math.exp(-10 * dt));
        }
      }
      // reset fire state while hunting
      this._fire.windup = 0;
      this._fire.burst = 0;
    } else {
      // combat: face player
      const targetYaw = Math.atan2(-dxp, -dzp);
      this.yaw = angleLerp(this.yaw, targetYaw, 1 - Math.exp(-12 * dt));

      // strafe + keep distance band
      this._strafeT -= dt;
      if (this._strafeT <= 0) {
        this._strafeT = 0.8 + Math.random() * 1.3;
        this._strafeDir = Math.random() > 0.5 ? 1 : -1;
      }
      const perpX = -dzp / distP, perpZ = dxp / distP;
      moveX = perpX * this._strafeDir;
      moveZ = perpZ * this._strafeDir;
      if (distP > cfg.rangeFar) {
        moveX += (dxp / distP) * 0.9;
        moveZ += (dzp / distP) * 0.9;
      } else if (distP < cfg.rangeNear) {
        moveX -= (dxp / distP) * 0.9;
        moveZ -= (dzp / distP) * 0.9;
      }
      const ml = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
      moveX /= ml;
      moveZ /= ml;
      wantSpeed = cfg.speed * 0.72;

      // firing state machine
      const f = this._fire;
      if (f.burst > 0) {
        f.interval -= dt;
        if (f.interval <= 0) {
          f.interval = 0.115;
          f.burst--;
          this._shoot(ctx, distP);
        }
      } else if (f.windup > 0) {
        f.windup -= dt;
        // telegraph: visor flares
        const k = 1 + Math.max(0, Math.sin((0.3 - f.windup) * 26)) * 1.2;
        this.accentMat.color.setRGB(0.9 * k, 0.28, 0.3);
        if (f.windup <= 0) {
          f.burst = cfg.burst;
          f.interval = 0;
        }
      } else {
        f.cooldown -= dt;
        this.accentMat.color.set(cfg.accent || ACCENT);
        if (f.cooldown <= 0 && distP < cfg.engageRange * 0.95) {
          f.windup = 0.3;
          f.cooldown = cfg.cooldown * (0.85 + Math.random() * 0.4);
        }
      }
    }

    // separation from other bots
    for (const other of ctx.bots) {
      if (other === this || !other.alive || other.state === "dead") continue;
      const sx = this.x - other.x, sz = this.z - other.z;
      const d2 = sx * sx + sz * sz;
      if (d2 < 1.44 && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        moveX += (sx / d) * (1.2 - d) * 1.4;
        moveZ += (sz / d) * (1.2 - d) * 1.4;
      }
    }

    // apply movement (nav-checked per axis)
    this._moveSpeed = damp(this._moveSpeed, wantSpeed, 8, dt);
    const nx = this.x + moveX * this._moveSpeed * dt;
    const nz = this.z + moveZ * this._moveSpeed * dt;
    if (ctx.nav.isOpenWorld(nx, this.z)) this.x = nx;
    if (ctx.nav.isOpenWorld(this.x, nz)) this.z = nz;

    // footsteps
    if (this._moveSpeed > 0.8) {
      this._stepT -= dt * this._moveSpeed;
      if (this._stepT <= 0) {
        this._stepT = 2.6;
        _v1.set(this.x, 0, this.z);
        audio.footstep(true, false, _v1);
      }
    }

    // --- animation ---
    this._flinch = Math.max(0, this._flinch - dt * 4);
    const speedK = clamp(this._moveSpeed / 3.4, 0, 1);
    this._walkPhase += dt * (4 + this._moveSpeed * 2.6);
    const swing = Math.sin(this._walkPhase) * 0.55 * speedK;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.6;
    const bob = Math.abs(Math.sin(this._walkPhase)) * 0.05 * speedK;

    this.root.position.set(this.x, bob, this.z);
    this.root.rotation.y = this.yaw;

    // aim arm pitch toward player in combat
    if (this.state === "combat") {
      const aimPitch = Math.atan2(ctx.player.eyeY - 1.3, Math.max(distP, 0.5));
      this.armR.rotation.x = damp(this.armR.rotation.x, -Math.PI / 2 + -aimPitch * 0.6, 10, dt);
      this.torso.rotation.x = this._flinch * 0.12;
    } else {
      this.armR.rotation.x = damp(this.armR.rotation.x, -swing * 0.6, 8, dt);
      this.torso.rotation.x = this._flinch * 0.12;
    }
  }

  _shoot(ctx, distP) {
    const cfg = this.cfg;
    // muzzle world position (approx right hand)
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const mx = this.x + c * 0.31 + s * -0.4;
    const mz = this.z - s * 0.31 + c * -0.4;
    const my = 1.32;

    audio.shot("bot", _v1.set(mx, my, mz));

    // accuracy roll — moving/crouching player is harder to hit
    const p = ctx.player;
    let hitChance = cfg.accuracy;
    hitChance *= 1 - clamp(p.speed2D / 7, 0, 0.55);
    if (p.crouch > 0.5) hitChance *= 0.85;
    hitChance *= clamp(1.25 - distP / cfg.engageRange, 0.35, 1);

    const tx = p.x, ty = p.eyeY - 0.25, tz = p.z;

    if (Math.random() < hitChance) {
      // blocked at the last moment? (player behind cover now)
      if (!ctx.statics.losBlocked(mx, my, mz, tx, ty, tz)) {
        ctx.effects.tracer(mx, my, mz, tx, ty, tz, "#ff7d7d");
        ctx.onPlayerHit(cfg.damage, this.x, this.z);
        return;
      }
    }
    // miss: shoot past the player with visible offset
    const missAng = Math.random() * Math.PI * 2;
    const missR = 0.5 + Math.random() * 0.9;
    let ex = tx + Math.cos(missAng) * missR;
    let ey = ty + (Math.random() - 0.3) * 0.8;
    let ez = tz + Math.sin(missAng) * missR;
    // extend the miss ray to a wall for a believable tracer
    let ddx = ex - mx, ddy = ey - my, ddz = ez - mz;
    const dl = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    ddx /= dl; ddy /= dl; ddz /= dl;
    let range = 40;
    if (ctx.statics.raycast(mx, my, mz, ddx, ddy, ddz, 40, _hit)) {
      range = _hit.t;
      ctx.effects.impact(mx + ddx * range, my + ddy * range, mz + ddz * range, _hit.nx, _hit.ny, _hit.nz);
    }
    ctx.effects.tracer(mx, my, mz, mx + ddx * range, my + ddy * range, mz + ddz * range, "#ff7d7d");
    if (dl < 6) audio.whiz((Math.random() - 0.5) * 1.2);
  }
}

let _hitPartCache = "body";

export class BotManager {
  constructor(scene) {
    this.scene = scene;
    this.bots = [];
    for (let i = 0; i < 8; i++) this.bots.push(new Bot(scene));
  }

  spawn(x, z, cfg, stagger = 0) {
    for (const b of this.bots) {
      if (!b.alive) {
        b.spawn(x, z, cfg, stagger);
        return b;
      }
    }
    return null;
  }

  get aliveCount() {
    let n = 0;
    for (const b of this.bots) if (b.alive) n++;
    return n;
  }

  update(dt, ctx) {
    ctx.bots = this.bots;
    for (const b of this.bots) b.update(dt, ctx);
  }

  // closest bot hit by ray; returns null or {bot, t, part}
  raycast(ox, oy, oz, dx, dy, dz, maxD, out) {
    let best = null;
    for (const b of this.bots) {
      if (!b.alive || b.state === "dead" || b.state === "spawning") continue;
      const t = b.testRay(ox, oy, oz, dx, dy, dz, maxD);
      if (t > 0 && (!best || t < best.t)) {
        out.bot = b;
        out.t = t;
        out.part = _hitPartCache;
        best = out;
      }
    }
    return best;
  }

  clear() {
    for (const b of this.bots) {
      b.alive = false;
      b.state = "idle";
      b.root.visible = false;
    }
  }
}
