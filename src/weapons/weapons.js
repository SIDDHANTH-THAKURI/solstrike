// Weapon logic: ammo, fire cadence, spread/bloom model, recoil dispatch,
// reload/switch state machine. Visuals live in viewmodel.js; ray/projectile
// resolution lives in game/combat.js (injected).

import * as THREE from "three";
import { WEAPONS, WEAPON_BY_ID } from "./defs.js";
import { input } from "../core/input.js";
import { audio } from "../core/audio.js";
import { clamp, lerp } from "../core/utils.js";

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

export class WeaponSystem {
  constructor(vm, camFeel, camera) {
    this.vm = vm;
    this.camFeel = camFeel;
    this.camera = camera;
    this.combat = null; // injected
    this.onAmmoChange = null;
    this.onWeaponChange = null;
    this.onScopeChange = null;

    this.inv = new Map();
    for (const def of WEAPONS) {
      this.inv.set(def.id, { def, mag: def.mag, reserve: def.reserve });
    }
    this.order = WEAPONS.slice().sort((a, b) => a.slot - b.slot).map((w) => w.id);

    this.current = "havoc";
    this.last = "vespa";
    this.state = "ready"; // ready | switching | reloading
    this.stateT = 0;
    this.fireTimer = 0;
    this.bloom = 0;
    this._prevFire = false;
    this._dryLatch = false;
    this._autoReloadT = 0;
    this._scopedNow = false;

    vm.onReloadStage = (stage) => audio.reloadTick(stage);
  }

  get def() {
    return this.inv.get(this.current).def;
  }
  get slotState() {
    return this.inv.get(this.current);
  }

  resetAll() {
    for (const s of this.inv.values()) {
      s.mag = s.def.mag;
      s.reserve = s.def.reserve;
    }
    this.current = "havoc";
    this.last = "vespa";
    this.state = "ready";
    this.fireTimer = 0;
    this.bloom = 0;
    this.vm.setWeapon("havoc");
    this.vm.scoped = false;
    this._emitAmmo();
    if (this.onWeaponChange) this.onWeaponChange();
  }

  restock() {
    for (const s of this.inv.values()) {
      s.mag = s.def.mag;
      s.reserve = s.def.reserve;
    }
    this._emitAmmo();
  }

  addAmmo() {
    // ammo crate: refill reserves fully + current mag
    for (const s of this.inv.values()) s.reserve = s.def.reserve;
    this._emitAmmo();
  }

  switchTo(id, silent = false) {
    if (id === this.current || !this.inv.has(id)) return;
    if (this.state === "switching" && this.stateT > 0.08) {
      // allow re-buffer near the end only
    }
    this.last = this.current;
    this.current = id;
    const def = this.def;
    this.state = "switching";
    this.stateT = def.switchTime;
    this.bloom = 0;
    this.vm.playSwitch(id, def.switchTime);
    this.vm.scoped = !!def.ads.scope;
    if (!silent) audio.switchWoosh();
    if (this.onWeaponChange) this.onWeaponChange();
    this._emitAmmo();
  }

  cycle(dirStep) {
    const i = this.order.indexOf(this.current);
    const n = this.order.length;
    this.switchTo(this.order[(i + dirStep + n) % n]);
  }

  tryReload() {
    const s = this.slotState;
    if (this.state !== "ready") return;
    if (s.mag >= s.def.mag || s.reserve <= 0) return;
    this.state = "reloading";
    this.stateT = s.def.reloadTime;
    this.vm.playReload(s.def.reloadTime);
  }

  currentSpread(ctl) {
    const def = this.def;
    const ads = this.camFeel.adsAmount;
    let base = def.spreadBase;
    if (def.ads.scope && ads > 0.5) base = def.scopedSpread;
    const speedNorm = clamp(ctl.speed2D / 5.7, 0, 1.2);
    let s = base + this.bloom + def.spreadMove * Math.pow(speedNorm, 1.25);
    if (!ctl.grounded) s += def.spreadAir;
    s *= lerp(1, def.ads.spreadMult, ads);
    if (ctl.crouch > 0.5) s *= 0.8;
    return s;
  }

  update(dt, ctl) {
    const s = this.slotState;
    const def = s.def;

    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.bloom = Math.max(0, this.bloom - def.bloomDecay * dt);

    // state machine
    if (this.state !== "ready") {
      this.stateT -= dt;
      if (this.stateT <= 0) {
        if (this.state === "reloading") {
          const need = def.mag - s.mag;
          const take = Math.min(need, s.reserve);
          s.mag += take;
          s.reserve -= take;
          this._emitAmmo();
        }
        this.state = "ready";
      }
    }

    // ADS
    const adsWanted = input.aiming && this.state === "ready" && input.locked !== false;
    this.camFeel.setADS(adsWanted, def.ads.zoom);
    this.vm.setADS(adsWanted);
    ctl.speedMult = lerp(1, def.ads.speedMult, this.camFeel.adsAmount);

    const scopedNow = !!def.ads.scope && this.camFeel.adsAmount > 0.8 && adsWanted;
    if (scopedNow !== this._scopedNow) {
      this._scopedNow = scopedNow;
      if (this.onScopeChange) this.onScopeChange(scopedNow);
    }

    // firing
    const held = input.firing;
    const edge = held && !this._prevFire;
    this._prevFire = held;
    if (!held) this._dryLatch = false;

    const wantsFire = def.kind === "auto" ? held : edge;
    if (wantsFire && this.state === "ready" && this.fireTimer <= 0) {
      if (s.mag > 0) {
        this._fire(ctl, s, def);
      } else if (!this._dryLatch) {
        this._dryLatch = true;
        audio.dryFire();
        this.tryReload();
      }
    }

    // auto reload when empty and idle
    if (s.mag === 0 && s.reserve > 0 && this.state === "ready") {
      this._autoReloadT += dt;
      if (this._autoReloadT > 0.35) this.tryReload();
    } else {
      this._autoReloadT = 0;
    }
  }

  _fire(ctl, s, def) {
    s.mag--;
    this.fireTimer = 60 / def.rpm;
    this.bloom = Math.min(this.bloom + def.bloomPerShot, def.bloomMax);

    const r = Math.random();
    this.camFeel.addRecoil(def.kickPitch * (0.9 + r * 0.2), def.kickYaw * (Math.random() - 0.5) * 2);
    this.vm.playFire(def);
    audio.shot(def.sound);

    const spread = this.currentSpread(ctl);
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    _up.setFromMatrixColumn(cam.matrixWorld, 1);
    this.vm.getMuzzleWorld(_muzzle);

    if (def.kind === "rocket") {
      _dir.copy(_fwd);
      this.combat.fireRocket(_muzzle, _dir, def);
    } else {
      const pellets = def.pellets || 1;
      for (let i = 0; i < pellets; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = spread * Math.sqrt(Math.random());
        _dir
          .copy(_fwd)
          .addScaledVector(_right, Math.cos(ang) * rad)
          .addScaledVector(_up, Math.sin(ang) * rad)
          .normalize();
        this.combat.fireHitscan(cam.position, _dir, def, _muzzle);
      }
    }
    this._emitAmmo();
  }

  handleSlotKey(n) {
    const id = this.order[n - 1];
    if (id) this.switchTo(id);
  }

  _emitAmmo() {
    if (this.onAmmoChange) this.onAmmoChange();
  }

  hudState() {
    const cur = this.slotState;
    return {
      name: cur.def.name,
      mag: cur.mag,
      reserve: cur.reserve,
      slots: this.order.map((id) => {
        const s = this.inv.get(id);
        return { id, name: s.def.name, slot: s.def.slot, mag: s.mag, reserve: s.reserve, active: id === this.current };
      }),
    };
  }
}
