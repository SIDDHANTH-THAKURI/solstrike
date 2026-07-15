// Combat resolution: hitscan rays (with thin-wall penetration for rifles/
// snipers), rocket projectiles, splash damage + knockback (rocket jumps),
// kill handling. Pure logic + effect/audio dispatch; no DOM.

import * as THREE from "three";
import { audio } from "../core/audio.js";
import { clamp } from "../core/utils.js";

const _hit = {};
const _botHit = {};
const _v = new THREE.Vector3();

const MAX_RANGE = 130;

export class Combat {
  constructor(statics, botMgr, effects, player, camFeel) {
    this.statics = statics;
    this.bots = botMgr;
    this.effects = effects;
    this.player = player;
    this.camFeel = camFeel;
    // events wired by session
    this.onBotDamaged = null; // (damage, part, killed, bot)
    this.onBotKilled = null; // (bot, part, cause)
    this.onPlayerDamaged = null;

    // rocket pool
    this.rockets = [];
    this._rocketMeshes = [];
  }

  initRockets(scene) {
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8),
        new THREE.MeshLambertMaterial({ color: "#e8e2d4" })
      );
      body.rotation.x = Math.PI / 2;
      g.add(body);
      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.001, 0.07, 0.16, 8),
        new THREE.MeshBasicMaterial({ color: "#ff7a1a" })
      );
      tip.rotation.x = -Math.PI / 2;
      tip.position.z = -0.29;
      g.add(tip);
      const glow = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.09, 0.14, 8),
        new THREE.MeshBasicMaterial({ color: "#ffc27a" })
      );
      glow.rotation.x = Math.PI / 2;
      glow.position.z = 0.26;
      g.add(glow);
      g.visible = false;
      scene.add(g);
      this.rockets.push({
        mesh: g,
        active: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0,
        trailT: 0,
        def: null,
      });
    }
  }

  falloff(def, dist) {
    if (!def.falloffStart) return 1;
    if (dist <= def.falloffStart) return 1;
    const k = clamp((dist - def.falloffStart) / (def.falloffEnd - def.falloffStart), 0, 1);
    return 1 - k * (1 - def.falloffMin);
  }

  fireHitscan(origin, dir, def, muzzle) {
    this._traceShot(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, def, muzzle.x, muzzle.y, muzzle.z, 1, def.penetrates);
  }

  _traceShot(ox, oy, oz, dx, dy, dz, def, mx, my, mz, dmgMult, canPen) {
    let wallT = MAX_RANGE;
    let hasWall = false;
    if (this.statics.raycast(ox, oy, oz, dx, dy, dz, MAX_RANGE, _hit)) {
      wallT = _hit.t;
      hasWall = true;
    }
    const wallBox = hasWall ? _hit.box : null;
    const wnx = _hit.nx, wny = _hit.ny, wnz = _hit.nz;

    const bh = this.bots.raycast(ox, oy, oz, dx, dy, dz, wallT, _botHit);
    if (bh) {
      const px = ox + dx * bh.t, py = oy + dy * bh.t, pz = oz + dz * bh.t;
      const dmg = Math.round(def.damage * (bh.part === "head" ? def.headMult : 1) * this.falloff(def, bh.t) * dmgMult);
      const killed = bh.bot.damage(dmg, bh.part);
      this.effects.tracer(mx, my, mz, px, py, pz, def.tracer);
      this.effects.hitSpark(px, py, pz, bh.part === "head");
      if (this.onBotDamaged) this.onBotDamaged(dmg, bh.part, killed, bh.bot, px, py, pz);
      if (killed) this._killBot(bh.bot, bh.part, "shot");
      return;
    }

    if (hasWall) {
      const px = ox + dx * wallT, py = oy + dy * wallT, pz = oz + dz * wallT;
      this.effects.tracer(mx, my, mz, px, py, pz, def.tracer);
      this.effects.impact(px, py, pz, wnx, wny, wnz);
      // penetrate thin walls once with reduced damage
      if (canPen && wallBox && wallBox.thin && dmgMult > 0.9) {
        const exitT = wallT + 0.55;
        this._traceShot(
          ox + dx * exitT, oy + dy * exitT, oz + dz * exitT,
          dx, dy, dz, def,
          ox + dx * exitT, oy + dy * exitT, oz + dz * exitT,
          0.62, false
        );
      }
    } else {
      this.effects.tracer(mx, my, mz, ox + dx * MAX_RANGE, oy + dy * MAX_RANGE, oz + dz * MAX_RANGE, def.tracer);
    }
  }

  fireRocket(origin, dir, def) {
    for (const r of this.rockets) {
      if (r.active) continue;
      r.active = true;
      r.def = def;
      r.x = origin.x; r.y = origin.y; r.z = origin.z;
      const sp = def.projectileSpeed;
      r.vx = dir.x * sp; r.vy = dir.y * sp; r.vz = dir.z * sp;
      r.life = 6;
      r.trailT = 0;
      r.mesh.visible = true;
      r.mesh.position.set(r.x, r.y, r.z);
      _v.set(dir.x, dir.y, dir.z);
      r.mesh.lookAt(r.x + _v.x, r.y + _v.y, r.z + _v.z);
      return;
    }
  }

  updateRockets(dt) {
    for (const r of this.rockets) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) {
        this.explode(r.x, r.y, r.z, r.def);
        this._despawnRocket(r);
        continue;
      }
      const nx = r.x + r.vx * dt;
      const ny = r.y + r.vy * dt;
      const nz = r.z + r.vz * dt;
      const segLen = Math.sqrt((nx - r.x) ** 2 + (ny - r.y) ** 2 + (nz - r.z) ** 2);
      const idl = 1 / (segLen || 1);
      const dx = (nx - r.x) * idl, dy = (ny - r.y) * idl, dz = (nz - r.z) * idl;

      // direct bot hit
      const bh = this.bots.raycast(r.x, r.y, r.z, dx, dy, dz, segLen, _botHit);
      if (bh) {
        const px = r.x + dx * bh.t, py = r.y + dy * bh.t, pz = r.z + dz * bh.t;
        const killed = bh.bot.damage(r.def.damage, "body");
        if (this.onBotDamaged) this.onBotDamaged(r.def.damage, "body", killed, bh.bot, px, py, pz);
        if (killed) this._killBot(bh.bot, "body", "rocket");
        this.explode(px, py, pz, r.def);
        this._despawnRocket(r);
        continue;
      }
      // wall hit
      if (this.statics.raycast(r.x, r.y, r.z, dx, dy, dz, segLen, _hit)) {
        const px = r.x + dx * _hit.t, py = r.y + dy * _hit.t, pz = r.z + dz * _hit.t;
        this.explode(px, py, pz, r.def);
        this._despawnRocket(r);
        continue;
      }
      r.x = nx; r.y = ny; r.z = nz;
      r.mesh.position.set(nx, ny, nz);

      r.trailT -= dt;
      if (r.trailT <= 0) {
        r.trailT = 0.022;
        this.effects.rocketTrail(r.x - dx * 0.3, r.y - dy * 0.3, r.z - dz * 0.3);
      }
    }
  }

  _despawnRocket(r) {
    r.active = false;
    r.mesh.visible = false;
  }

  explode(x, y, z, def) {
    this.effects.explosion(x, y, z);
    audio.explosion(_v.set(x, y, z));

    const radius = def.splashRadius;
    // bots
    for (const b of this.bots.bots) {
      if (!b.alive || b.state === "dead") continue;
      const dx = b.x - x, dy = 1.0 - y, dz = b.z - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > radius) continue;
      let dmg = def.splashDamage * Math.pow(1 - d / radius, 1.05);
      // half damage through cover
      if (this.statics.losBlocked(x, y + 0.2, z, b.x, 1.0, b.z)) dmg *= 0.4;
      dmg = Math.round(dmg);
      if (dmg <= 0) continue;
      const killed = b.damage(dmg, "body");
      if (this.onBotDamaged) this.onBotDamaged(dmg, "body", killed, b, b.x, 1.2, b.z);
      if (killed) this._killBot(b, "body", "rocket");
    }

    // player: self damage + knockback (rocket jump)
    const p = this.player;
    const pdx = p.x - x, pdy = p.y + 0.9 - y, pdz = p.z - z;
    const pd = Math.sqrt(pdx * pdx + pdy * pdy + pdz * pdz);
    if (pd < radius + 0.6) {
      const k = Math.pow(1 - clamp(pd / (radius + 0.6), 0, 1), 1.05);
      const dmg = Math.round(def.splashDamage * k * def.selfDamageMult);
      const kb = 11 * k;
      const il = 1 / (pd || 1);
      p.impulse(pdx * il * kb, Math.max(pdy * il, 0.45) * kb + 2.4 * k, pdz * il * kb);
      if (dmg > 0 && this.onPlayerDamaged) this.onPlayerDamaged(dmg, x, z, true);
    }
    this.camFeel.addTrauma(clamp(1 - pd / 24, 0.25, 0.8));
  }

  // SUNBURST ultimate: massive vertical strike. Damage comes from the sky,
  // so bots under solid roofs are shielded (intuitive + fair); everything
  // in the open inside the radius gets deleted.
  sunburstBlast(x, z) {
    const RADIUS = 9;
    for (const b of this.bots.bots) {
      if (!b.alive || b.state === "dead") continue;
      const dx = b.x - x, dz = b.z - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > RADIUS) continue;
      if (this.statics.losBlocked(b.x, 30, b.z, b.x, 1.2, b.z)) continue; // roofed
      const dmg = Math.round(420 * (1 - (d / RADIUS) * 0.65));
      const killed = b.damage(dmg, "body");
      if (this.onBotDamaged) this.onBotDamaged(dmg, "body", killed, b, b.x, 1.4, b.z);
      if (killed) this._killBot(b, "body", "sunburst");
    }
    // player knockback if standing in their own strike (no damage — your ult)
    const p = this.player;
    const pdx = p.x - x, pdz = p.z - z;
    const pd = Math.sqrt(pdx * pdx + pdz * pdz);
    if (pd < RADIUS) {
      const k = 1 - pd / RADIUS;
      const il = 1 / (pd || 1);
      p.impulse(pdx * il * 10 * k, 6 * k + 2, pdz * il * 10 * k);
    }
    this.camFeel.addTrauma(1);
  }

  _killBot(bot, part, cause) {
    bot.kill();
    this.effects.shatter(bot.x, 0.2, bot.z, "#606c78", bot.cfg.accent || "#e5484d");
    _v.set(bot.x, 1, bot.z);
    audio.botDeath(_v);
    if (this.onBotKilled) this.onBotKilled(bot, part, cause);
  }

  clearRockets() {
    for (const r of this.rockets) this._despawnRocket(r);
  }
}
