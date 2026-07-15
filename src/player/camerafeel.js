// Camera presentation: bob, land dip, recoil spring, explosion shake, ADS
// zoom. Pure visual layer on top of the controller's yaw/pitch — recoil
// returns to center on its own so spraying feels punchy but controllable.

import * as THREE from "three";
import { clamp, damp } from "../core/utils.js";
import { settings } from "../core/settings.js";

const _euler = new THREE.Euler(0, 0, 0, "YXZ");

export class CameraFeel {
  constructor(camera) {
    this.camera = camera;
    // recoil spring (pitch/yaw offsets in radians)
    this.rPitch = 0;
    this.rYaw = 0;
    this.rvPitch = 0;
    this.rvYaw = 0;
    // shake
    this.trauma = 0;
    this._shakeT = 0;
    // bob
    this._bobPhase = 0;
    this._bobAmp = 0;
    // landing dip
    this._dip = 0;
    this._dipV = 0;
    // ADS
    this.adsAmount = 0; // smoothed 0..1
    this._adsTarget = 0;
    this._zoom = 1;
    this.roll = 0; // strafe lean
  }

  addRecoil(pitchKick, yawKick) {
    this.rvPitch += pitchKick;
    this.rvYaw += yawKick;
  }

  addTrauma(v) {
    this.trauma = clamp(this.trauma + v, 0, 1);
  }

  landDip(strength) {
    this._dipV -= clamp(strength, 0, 3.2);
  }

  setADS(on, zoom) {
    this._adsTarget = on ? 1 : 0;
    if (on) this._zoom = zoom;
  }

  update(dt, ctl, moving, strafe = 0) {
    const cam = this.camera;

    // recoil spring: stiff return, slight overshoot
    const K = 130, D = 14;
    this.rvPitch += (-K * this.rPitch - D * this.rvPitch) * dt;
    this.rvYaw += (-K * this.rYaw - D * this.rvYaw) * dt;
    this.rPitch += this.rvPitch * dt;
    this.rYaw += this.rvYaw * dt;

    // shake decay
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    this._shakeT += dt * 30;
    const sh = this.trauma * this.trauma;
    const shX = sh * 0.05 * Math.sin(this._shakeT * 1.3) * Math.sin(this._shakeT * 4.7);
    const shY = sh * 0.05 * Math.sin(this._shakeT * 1.7 + 9) * Math.sin(this._shakeT * 3.9);
    const shR = sh * 0.06 * Math.sin(this._shakeT * 2.3 + 4);

    // bob while running on ground
    const wantAmp = moving && ctl.grounded && settings.bob ? clamp(ctl.speed2D / 5.7, 0, 1) : 0;
    this._bobAmp = damp(this._bobAmp, wantAmp, 8, dt);
    if (this._bobAmp > 0.002) this._bobPhase += dt * (7.2 + ctl.speed2D * 0.7);
    const adsCut = 1 - this.adsAmount * 0.85;
    const bobY = Math.abs(Math.sin(this._bobPhase)) * 0.036 * this._bobAmp * adsCut;
    const bobX = Math.sin(this._bobPhase * 0.5) * 0.012 * this._bobAmp * adsCut;

    // land dip spring
    this._dipV += (-160 * this._dip - 16 * this._dipV) * dt;
    this._dip += this._dipV * dt;

    // strafe roll
    this.roll = damp(this.roll, clamp(-strafe, -1, 1) * 0.008, 10, dt);

    // ADS blend
    this.adsAmount = damp(this.adsAmount, this._adsTarget, 16, dt);

    // FOV
    const baseFov = settings.fov;
    const fov = baseFov / (1 + (this._zoom - 1) * this.adsAmount);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    // compose
    cam.position.set(ctl.x + bobX + shX, ctl.eyeY + bobY + this._dip * 0.22 + shY, ctl.z);
    _euler.set(
      ctl.pitch + this.rPitch + this._dip * 0.03,
      ctl.yaw + this.rYaw + shX * 0.6,
      this.roll + shR,
      "YXZ"
    );
    cam.quaternion.setFromEuler(_euler);
  }
}
