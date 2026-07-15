// SUNBURST — the ultimate. An orbital solar lance: ground telegraph ring,
// then a blinding sky pillar slams down with shockwaves, ember fallout and
// a sustained rumble. All meshes prebuilt + reused; nothing allocates while
// firing. The session polls `rumble` each frame to feed camera shake, and
// `flash` to drive the white screen-flash overlay.

import * as THREE from "three";

function pillarTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.25, "rgba(255,244,220,0.55)");
  grad.addColorStop(0.75, "rgba(255,220,150,0.95)");
  grad.addColorStop(1, "rgba(255,255,255,1)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  // vertical streaks for energy texture
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 9; i++) {
    const x = Math.random() * 64;
    g.fillStyle = `rgba(0,0,0,${0.12 + Math.random() * 0.22})`;
    g.fillRect(x, 0, 1.5 + Math.random() * 3, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

const TELEGRAPH_TIME = 0.95;
const BLAST_HOLD = 0.55;
const FADE_TIME = 0.7;

export class Sunburst {
  constructor(scene) {
    this.scene = scene;
    this.phase = "idle"; // idle | telegraph | blast | fade
    this.t = 0;
    this.x = 0;
    this.z = 0;
    this.rumble = 0; // 0..1, polled by session for camera trauma
    this.flash = 0; // 0..1, polled for the screen flash overlay
    this.onImpact = null;

    const tex = pillarTexture();

    // core pillar (tight, bright) + outer sheath (wide, softer), counter-rotating
    const mkPillar = (r, opacity) => {
      const geo = new THREE.CylinderGeometry(r, r * 1.15, 90, 24, 1, true);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        color: "#ffd9a0",
        fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.y = 45;
      m.visible = false;
      m.frustumCulled = false;
      return m;
    };
    this.pillarCore = mkPillar(1.6, 0.95);
    this.pillarCore.material.color.set("#fff6e0");
    this.pillarOuter = mkPillar(3.4, 0.5);
    this.group = new THREE.Group();
    this.group.add(this.pillarCore, this.pillarOuter);

    // telegraph ring on the ground
    this.teleRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 48),
      new THREE.MeshBasicMaterial({
        color: "#ffb04d",
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      })
    );
    this.teleRing.rotation.x = -Math.PI / 2;
    this.teleRing.visible = false;
    this.group.add(this.teleRing);

    // beacon: thin pre-beam during telegraph
    this.beacon = mkPillar(0.22, 0.75);
    this.group.add(this.beacon);

    // impact shockwave rings (3, staggered)
    this.shocks = [];
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 48),
        new THREE.MeshBasicMaterial({
          color: i === 0 ? "#ffffff" : "#ffb04d",
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        })
      );
      s.rotation.x = -Math.PI / 2;
      s.visible = false;
      this.group.add(s);
      this.shocks.push(s);
    }

    // ground glow disc at impact
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({
        color: "#ffdf9e",
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.visible = false;
    this.group.add(this.glow);

    // blast light — actually illuminates the arena for a beat
    this.light = new THREE.PointLight("#ffca7a", 0, 40, 1.4);
    this.light.position.y = 3;
    this.group.add(this.light);

    scene.add(this.group);
  }

  get active() {
    return this.phase !== "idle";
  }

  fire(x, z, onImpact) {
    if (this.active) return false;
    this.x = x;
    this.z = z;
    this.onImpact = onImpact;
    this.phase = "telegraph";
    this.t = 0;
    this.group.position.set(x, 0.02, z);
    this.teleRing.visible = true;
    this.beacon.visible = true;
    this.beacon.material.opacity = 0;
    return true;
  }

  _impact(effects) {
    this.phase = "blast";
    this.t = 0;
    this.teleRing.visible = false;
    this.beacon.visible = false;
    this.pillarCore.visible = true;
    this.pillarOuter.visible = true;
    this.glow.visible = true;
    for (const s of this.shocks) s.visible = true;
    this.flash = 1;
    if (this.onImpact) this.onImpact(this.x, this.z);

    if (effects) {
      // embers: launched up, rain back down
      for (let i = 0; i < 34; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 5;
        effects.sparks.spawn(
          this.x + Math.cos(a) * r, 0.4, this.z + Math.sin(a) * r,
          Math.cos(a) * (2 + Math.random() * 5), 7 + Math.random() * 10, Math.sin(a) * (2 + Math.random() * 5),
          0.9 + Math.random() * 0.8, 0.1, 0.02,
          1, 0.72, 0.3, 1, 10, 0.6
        );
      }
      // debris + smoke column
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 4 + Math.random() * 8;
        effects.cubes.spawn(this.x, 0.5, this.z, Math.cos(a) * sp, 5 + Math.random() * 8, Math.sin(a) * sp, 0.12 + Math.random() * 0.14, 1.1 + Math.random() * 0.5, i % 2 ? "#6b5b4c" : "#a89383");
      }
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        effects.smoke.spawn(
          this.x + Math.cos(a) * 1.2, 0.6 + Math.random(), this.z + Math.sin(a) * 1.2,
          Math.cos(a) * 2.2, 2.6 + Math.random() * 2, Math.sin(a) * 2.2,
          1.5 + Math.random() * 0.7, 1.0, 3.6, 0.66, 0.6, 0.55, 0.55, -0.5, 1.2
        );
      }
      effects.decals.spawn(this.x, 0.01, this.z, 0, 1, 0, 7.5);
    }
  }

  // dt-driven timeline; `effects` passed so impact can burst particles
  update(dt, effects) {
    // flash always decays fast — it's a strobe, not a whiteout
    this.flash = Math.max(0, this.flash - dt * 3.2);
    if (this.phase === "idle") {
      this.rumble = Math.max(0, this.rumble - dt * 2);
      return;
    }
    this.t += dt;

    if (this.phase === "telegraph") {
      const k = Math.min(this.t / TELEGRAPH_TIME, 1);
      const r = 1.5 + k * 7.5;
      this.teleRing.scale.setScalar(r);
      this.teleRing.material.opacity = 0.35 + 0.55 * Math.abs(Math.sin(this.t * (6 + k * 18)));
      this.beacon.material.opacity = k * 0.8;
      this.beacon.rotation.y += dt * 4;
      this.rumble = Math.min(this.rumble + dt * 0.35, 0.35);
      if (this.t >= TELEGRAPH_TIME) this._impact(effects);
      return;
    }

    if (this.phase === "blast") {
      const k = Math.min(this.t / BLAST_HOLD, 1);
      // pillar slams wide fast, then breathes
      const w = 0.4 + Math.min(k * 3, 1) * 1 + Math.sin(this.t * 30) * 0.05;
      this.pillarCore.scale.set(w, 1, w);
      this.pillarOuter.scale.set(w, 1, w);
      this.pillarCore.rotation.y += dt * 7;
      this.pillarOuter.rotation.y -= dt * 4;
      this.glow.scale.setScalar(2 + k * 9);
      this.glow.material.opacity = 0.85 * (1 - k * 0.4);
      this.light.intensity = 260 * (1 - k * 0.35);
      for (let i = 0; i < this.shocks.length; i++) {
        const sk = Math.max(0, Math.min((this.t - i * 0.12) / 0.75, 1));
        this.shocks[i].scale.setScalar(1 + sk * (16 + i * 7));
        this.shocks[i].material.opacity = 0.85 * (1 - sk);
        this.shocks[i].position.y = 0.05 + i * 0.35 * sk;
      }
      this.rumble = 1;
      if (this.t >= BLAST_HOLD) {
        this.phase = "fade";
        this.t = 0;
      }
      return;
    }

    // fade
    const k = Math.min(this.t / FADE_TIME, 1);
    const op = 1 - k;
    this.pillarCore.material.opacity = 0.95 * op;
    this.pillarOuter.material.opacity = 0.5 * op;
    this.pillarCore.rotation.y += dt * 5;
    this.pillarOuter.rotation.y -= dt * 3;
    const w = (1.4 + k * 0.6) * (1 - k * 0.55);
    this.pillarCore.scale.set(w, 1, w);
    this.pillarOuter.scale.set(w, 1, w);
    this.glow.material.opacity = 0.5 * op;
    this.light.intensity = 170 * op;
    this.rumble = Math.max(0, 1 - k * 1.4);
    for (let i = 0; i < this.shocks.length; i++) {
      const sk = Math.max(0, Math.min((BLAST_HOLD + this.t - i * 0.12) / 0.75, 1));
      this.shocks[i].scale.setScalar(1 + sk * (16 + i * 7));
      this.shocks[i].material.opacity = 0.85 * (1 - sk);
      if (sk >= 1) this.shocks[i].visible = false;
    }
    if (k >= 1) {
      this.phase = "idle";
      this.pillarCore.visible = false;
      this.pillarOuter.visible = false;
      this.glow.visible = false;
      for (const s of this.shocks) s.visible = false;
      this.pillarCore.material.opacity = 0.95;
      this.pillarOuter.material.opacity = 0.5;
      this.light.intensity = 0;
    }
  }
}
