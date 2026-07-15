// Gun-only viewmodel: rendered in an overlay scene so it never clips level
// geometry. All animation is procedural — sway, bob, fire kick, reload
// choreography, weapon switch lower/raise, shell ejection, muzzle flash.

import * as THREE from "three";
import { GUN_BUILDERS } from "./models.js";
import { clamp, damp, easeOutBack, easeOutCubic } from "../core/utils.js";

const HIP = new THREE.Vector3(0.26, -0.25, -0.5);
const ADS = new THREE.Vector3(0, -0.153, -0.36);
const _v = new THREE.Vector3();

function flashTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.translate(32, 32);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  grad.addColorStop(0, "rgba(255,255,235,1)");
  grad.addColorStop(0.35, "rgba(255,205,110,0.9)");
  grad.addColorStop(1, "rgba(255,140,40,0)");
  g.fillStyle = grad;
  g.fillRect(-32, -32, 64, 64);
  g.fillStyle = "rgba(255,245,215,0.95)";
  for (let i = 0; i < 4; i++) {
    g.rotate(Math.PI / 4);
    g.fillRect(-2.4, -30, 4.8, 60);
  }
  return new THREE.CanvasTexture(c);
}

export class ViewModel {
  constructor(mainCamera, mainScene) {
    this.mainCamera = mainCamera;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 6);

    this.scene.add(new THREE.HemisphereLight("#ffffff", "#8a8276", 1.05));
    const key = new THREE.DirectionalLight("#fff2dd", 1.6);
    key.position.set(0.6, 1.2, 0.4);
    this.scene.add(key);

    this.rig = new THREE.Group();
    this.rig.scale.setScalar(0.78); // slimmer, less screen-hogging guns
    this.scene.add(this.rig);

    this.guns = {};
    for (const [id, build] of Object.entries(GUN_BUILDERS)) {
      const parts = build();
      parts.group.visible = false;
      parts.magHome = parts.mag.position.clone();
      parts.magRotHome = parts.mag.rotation.x;
      parts.slideHome = parts.slide.position.clone();
      this.rig.add(parts.group);
      this.guns[id] = parts;
    }
    this.currentId = null;

    // muzzle flash quad + world light
    const fm = new THREE.MeshBasicMaterial({
      map: flashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), fm);
    this.flash.visible = false;
    this.scene.add(this.flash);
    this._flashT = 0;

    this.flashLight = new THREE.PointLight("#ffc27a", 0, 11, 1.8);
    mainScene.add(this.flashLight);

    // shell pool
    this.shells = [];
    const shellGeo = new THREE.BoxGeometry(0.012, 0.012, 0.03);
    const shellMat = new THREE.MeshStandardMaterial({ color: "#d8b45a", roughness: 0.35, metalness: 0.7 });
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Mesh(shellGeo, shellMat);
      s.visible = false;
      s.userData = { vx: 0, vy: 0, vz: 0, life: 0, rx: 0, rz: 0 };
      this.scene.add(s);
      this.shells.push(s);
    }
    this._shellIdx = 0;

    // animation state
    this.adsAmount = 0;
    this._adsTarget = 0;
    this._swayX = 0;
    this._swayY = 0;
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._kickZ = 0;
    this._kickZV = 0;
    this._kickRX = 0;
    this._kickRXV = 0;
    this._switch = null; // {from, to, dur, t}
    this._reload = null; // {dur, t, stagesFired}
    this._idleT = 0;
    this.onReloadStage = null;
    this.scoped = false;
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setWeapon(id) {
    if (this.currentId) this.guns[this.currentId].group.visible = false;
    this.currentId = id;
    const g = this.guns[id];
    g.group.visible = true;
    g.mag.position.copy(g.magHome);
    g.mag.rotation.x = g.magRotHome;
    this._switch = null;
    this._reload = null;
  }

  playSwitch(toId, dur) {
    this._reload = null;
    this._switch = { to: toId, dur, t: 0, swapped: false };
  }

  playReload(dur) {
    this._reload = { dur, t: 0, stages: [false, false, false] };
  }

  playFire(def) {
    this._kickZV += def.vmKick * 3.4;
    this._kickRXV += def.vmKick * 1.6;
    // flash
    this._flashT = 0.045;
    if (def.id !== "longbow" || this.adsAmount < 0.5) {
      this.flash.visible = true;
      this.flash.scale.setScalar(0.55 + Math.random() * 0.4);
      this.flash.rotation.z = Math.random() * Math.PI;
    }
    this.flashLight.intensity = 15;
    // shells for ballistic guns
    if (def.id !== "ogre") this._ejectShell();
  }

  bump(v) {
    this._kickZV += v * 0.35;
    this._kickRXV -= v * 0.5;
  }

  setADS(on) {
    this._adsTarget = on ? 1 : 0;
  }

  _ejectShell() {
    const s = this.shells[this._shellIdx];
    this._shellIdx = (this._shellIdx + 1) % this.shells.length;
    const g = this.rig.position;
    s.position.set(g.x + 0.05, g.y + 0.03, g.z - 0.05);
    s.userData.vx = 0.9 + Math.random() * 0.5;
    s.userData.vy = 1.3 + Math.random() * 0.5;
    s.userData.vz = 0.2 + Math.random() * 0.3;
    s.userData.rx = Math.random() * 20 - 10;
    s.userData.rz = Math.random() * 20 - 10;
    s.userData.life = 0.8;
    s.visible = true;
  }

  getMuzzleWorld(out) {
    const gun = this.guns[this.currentId];
    if (!gun) return out.set(0, 0, 0);
    gun.muzzle.getWorldPosition(_v); // vm-scene coords == camera space
    return this.mainCamera.localToWorld(out.copy(_v));
  }

  update(dt, look, ctl, moving) {
    this._idleT += dt;
    const gun = this.guns[this.currentId];
    if (!gun) return;

    // --- ADS blend ---
    this.adsAmount = damp(this.adsAmount, this._adsTarget, 15, dt);
    const ads = this.adsAmount;

    // --- sway from look deltas (springy, reduced when aiming) ---
    const swayScale = (1 - ads * 0.75) * 1.0;
    this._swayX = damp(this._swayX, clamp(-look.x * 5, -0.06, 0.06) * swayScale, 9, dt);
    this._swayY = damp(this._swayY, clamp(-look.y * 5, -0.05, 0.05) * swayScale, 9, dt);

    // --- bob ---
    const wantAmp = moving && ctl.grounded ? clamp(ctl.speed2D / 5.7, 0, 1) : 0;
    this._bobAmp = damp(this._bobAmp, wantAmp, 7, dt);
    if (this._bobAmp > 0.002) this._bobPhase += dt * (6.4 + ctl.speed2D * 0.75);
    const bobCut = (1 - ads * 0.9) * this._bobAmp;
    const bobY = Math.sin(this._bobPhase * 2) * 0.011 * bobCut;
    const bobX = Math.sin(this._bobPhase) * 0.014 * bobCut;
    const bobR = Math.sin(this._bobPhase) * 0.012 * bobCut;

    // --- fire kick springs ---
    this._kickZV += (-320 * this._kickZ - 22 * this._kickZV) * dt;
    this._kickZ += this._kickZV * dt;
    this._kickRXV += (-300 * this._kickRX - 20 * this._kickRXV) * dt;
    this._kickRX += this._kickRXV * dt;

    // --- base pose ---
    const px = HIP.x + (ADS.x - HIP.x) * ads;
    const py = HIP.y + (ADS.y - HIP.y) * ads;
    const pz = HIP.z + (ADS.z - HIP.z) * ads;

    let posX = px + bobX * 0.6 + this._swayX * 0.35;
    let posY = py + bobY + this._swayY * 0.3 + Math.sin(this._idleT * 1.7) * 0.0016 * (1 - ads);
    let posZ = pz + this._kickZ;
    let rotX = this._swayY * 1.1 + this._kickRX;
    let rotY = this._swayX * 1.2;
    let rotZ = bobR + this._swayX * 0.5;

    // --- switch animation ---
    if (this._switch) {
      const s = this._switch;
      s.t += dt;
      const half = s.dur * 0.4;
      if (s.t < half) {
        const k = s.t / half;
        posY -= 0.38 * easeOutCubic(k);
        rotX -= 0.7 * k;
      } else {
        if (!s.swapped) {
          s.swapped = true;
          this.setWeapon(s.to);
          this._switch = s; // setWeapon cleared it
        }
        const k = clamp((s.t - half) / (s.dur - half), 0, 1);
        const e = easeOutBack(k);
        posY -= 0.38 * (1 - e);
        rotX -= 0.7 * (1 - k) * (1 - k);
        if (k >= 1) this._switch = null;
      }
    }

    // --- reload animation ---
    const g2 = this.guns[this.currentId];
    if (this._reload) {
      const r = this._reload;
      r.t += dt;
      const t = clamp(r.t / r.dur, 0, 1);
      const stage = (i, at) => {
        if (!r.stages[i] && t >= at) {
          r.stages[i] = true;
          if (this.onReloadStage) this.onReloadStage(i);
        }
      };
      stage(0, 0.14);
      stage(1, 0.56);
      stage(2, 0.82);

      // gun tilt
      let tilt;
      if (t < 0.25) tilt = easeOutCubic(t / 0.25);
      else if (t < 0.75) tilt = 1;
      else tilt = 1 - easeOutCubic((t - 0.75) / 0.25);
      rotX -= 0.34 * tilt;
      rotZ += 0.22 * tilt;
      posY -= 0.05 * tilt;

      // magazine motion
      if (t < 0.3) {
        const k = easeOutCubic(clamp((t - 0.1) / 0.2, 0, 1));
        g2.mag.position.y = g2.magHome.y - 0.16 * k;
        g2.mag.rotation.x = g2.magRotHome + 0.5 * k;
      } else if (t < 0.62) {
        const k = easeOutCubic(clamp((t - 0.36) / 0.26, 0, 1));
        g2.mag.position.y = g2.magHome.y - 0.16 * (1 - k);
        g2.mag.rotation.x = g2.magRotHome + 0.5 * (1 - k);
      } else {
        g2.mag.position.copy(g2.magHome);
        g2.mag.rotation.x = g2.magRotHome;
        // slide rack
        if (t > 0.78 && t < 0.9) {
          const k = Math.sin(((t - 0.78) / 0.12) * Math.PI);
          g2.slide.position.z = g2.slideHome.z + 0.035 * k;
        } else {
          g2.slide.position.copy(g2.slideHome);
        }
      }

      if (t >= 1) {
        g2.mag.position.copy(g2.magHome);
        g2.mag.rotation.x = g2.magRotHome;
        g2.slide.position.copy(g2.slideHome);
        this._reload = null;
      }
    }

    this.rig.position.set(posX, posY, posZ);
    this.rig.rotation.set(rotX, rotY, rotZ);

    // hide gun fully when scoped in (scope overlay takes over)
    g2.group.visible = !(this.scoped && ads > 0.82) || this._switch != null;

    // --- muzzle flash ---
    if (this._flashT > 0) {
      this._flashT -= dt;
      if (this._flashT <= 0) this.flash.visible = false;
      else {
        const gunNow = this.guns[this.currentId];
        gunNow.muzzle.getWorldPosition(this.flash.position);
        this.flashLight.intensity *= 0.6;
        this.getMuzzleWorld(this.flashLight.position);
      }
    } else if (this.flashLight.intensity > 0.01) {
      this.flashLight.intensity *= 0.5;
    } else {
      this.flashLight.intensity = 0;
    }

    // --- shells ---
    for (const s of this.shells) {
      if (!s.visible) continue;
      const u = s.userData;
      u.life -= dt;
      if (u.life <= 0) {
        s.visible = false;
        continue;
      }
      u.vy -= 8 * dt;
      s.position.x += u.vx * dt;
      s.position.y += u.vy * dt;
      s.position.z += u.vz * dt;
      s.rotation.x += u.rx * dt;
      s.rotation.z += u.rz * dt;
    }
  }

  render(renderer) {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
