// Field pickups: medkits + ammo crates at fixed map spots, respawning on a
// timer. Simple bobbing/rotating meshes + glow ring; touch radius pickup.

import * as THREE from "three";
import { audio } from "../core/audio.js";

const HEALTH_RESPAWN = 22;
const AMMO_RESPAWN = 17;

export class Pickups {
  constructor(scene, spots) {
    this.scene = scene;
    this.items = [];
    this._t = 0;

    for (const spot of spots) {
      const g = new THREE.Group();
      g.position.set(spot.x, 0, spot.z);

      if (spot.kind === "health") {
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(0.52, 0.34, 0.52),
          new THREE.MeshLambertMaterial({ color: "#f8f6f0" })
        );
        body.position.y = 0.5;
        body.castShadow = true;
        g.add(body);
        const crossMat = new THREE.MeshBasicMaterial({ color: "#e5484d" });
        const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.54), crossMat);
        c1.position.y = 0.5;
        g.add(c1);
        const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.54), crossMat);
        c2.position.y = 0.5;
        g.add(c2);
      } else {
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(0.56, 0.36, 0.4),
          new THREE.MeshLambertMaterial({ color: "#5d6b52" })
        );
        body.position.y = 0.5;
        body.castShadow = true;
        g.add(body);
        const lid = new THREE.Mesh(
          new THREE.BoxGeometry(0.6, 0.08, 0.44),
          new THREE.MeshLambertMaterial({ color: "#7a8a6a" })
        );
        lid.position.y = 0.7;
        g.add(lid);
        for (let i = 0; i < 3; i++) {
          const b = new THREE.Mesh(
            new THREE.CylinderGeometry(0.045, 0.045, 0.22, 6),
            new THREE.MeshBasicMaterial({ color: "#e9c46a" })
          );
          b.position.set(-0.12 + i * 0.12, 0.78, 0);
          g.add(b);
        }
      }

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.72, 24),
        new THREE.MeshBasicMaterial({
          color: spot.kind === "health" ? "#ff8a8a" : "#ffd166",
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      g.add(ring);

      this.scene.add(g);
      this.items.push({ kind: spot.kind, mesh: g, ring, active: true, timer: 0, x: spot.x, z: spot.z });
    }
  }

  update(dt, player, tryApply) {
    this._t += dt;
    for (const it of this.items) {
      if (!it.active) {
        it.timer -= dt;
        if (it.timer <= 0) {
          it.active = true;
          it.mesh.visible = true;
        }
        continue;
      }
      it.mesh.rotation.y = this._t * 1.4;
      it.mesh.position.y = Math.sin(this._t * 2.2 + it.x) * 0.07 + 0.05;
      it.ring.material.opacity = 0.4 + Math.sin(this._t * 3) * 0.15;

      const dx = player.x - it.x, dz = player.z - it.z;
      if (dx * dx + dz * dz < 1.55 && player.y < 1.2) {
        if (tryApply(it.kind)) {
          it.active = false;
          it.mesh.visible = false;
          it.timer = it.kind === "health" ? HEALTH_RESPAWN : AMMO_RESPAWN;
          audio.pickup(it.kind);
        }
      }
    }
  }

  reset() {
    for (const it of this.items) {
      it.active = true;
      it.mesh.visible = true;
      it.timer = 0;
    }
  }

  dispose() {
    for (const it of this.items) {
      this.scene.remove(it.mesh);
      it.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.items.length = 0;
  }
}
