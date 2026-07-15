// Renderer + frame loop + quality tiers. autoClear is off because the gun
// viewmodel renders as a second pass over the world.

import * as THREE from "three";

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.quality = "high";
    this.shadowsOn = true;
    this.shadowSize = 2048;

    this._fpsAcc = 0;
    this._fpsN = 0;
    this.fps = 60;
    this.onFps = null;

    this._cb = null;
    this._last = performance.now();
    this._raf = 0;

    window.addEventListener("resize", () => this._resize());
    this._resize();
  }

  applyQuality(q) {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    if (q === "high") {
      this.renderer.setPixelRatio(Math.min(dpr, 1.75));
      this.shadowsOn = true;
      this.shadowSize = 2048;
    } else if (q === "medium") {
      this.renderer.setPixelRatio(Math.min(dpr, 1.25));
      this.shadowsOn = true;
      this.shadowSize = 1024;
    } else {
      this.renderer.setPixelRatio(1);
      this.shadowsOn = false;
      this.shadowSize = 512;
    }
    this.renderer.shadowMap.enabled = this.shadowsOn;
    this._resize();
  }

  // apply current tier to a map's directional light
  configureLight(dir) {
    dir.castShadow = this.shadowsOn;
    dir.shadow.mapSize.set(this.shadowSize, this.shadowSize);
    if (dir.shadow.map) {
      dir.shadow.map.dispose();
      dir.shadow.map = null;
    }
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.onResize) this.onResize(w, h);
  }

  start(cb) {
    this._cb = cb;
    this._last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      let dt = (now - this._last) / 1000;
      this._last = now;
      if (dt > 0.05) dt = 0.05; // clamp hitches; sim never explodes
      // fps meter
      this._fpsAcc += dt;
      this._fpsN++;
      if (this._fpsAcc >= 0.5) {
        this.fps = Math.round(this._fpsN / this._fpsAcc);
        this._fpsAcc = 0;
        this._fpsN = 0;
        if (this.onFps) this.onFps(this.fps);
      }
      this._cb(dt, now / 1000);
    };
    this._raf = requestAnimationFrame(tick);
  }
}

// dispose a whole scene's GPU resources, skipping materials flagged shared
export function deepDispose(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (m) {
      if (Array.isArray(m)) {
        for (const mm of m) if (!mm.userData.shared) mm.dispose();
      } else if (!m.userData.shared) {
        m.dispose();
      }
    }
  });
}
