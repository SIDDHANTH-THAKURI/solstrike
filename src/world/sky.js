// Sky: gradient dome shader (with sun disc + halo baked into the fragment)
// plus a handful of drifting soft cloud sprites from a generated canvas
// texture. The dome follows the camera so it never clips.

import * as THREE from "three";

let _cloudTex = null;
function cloudTexture() {
  if (_cloudTex) return _cloudTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  // layered soft blobs
  const blob = (x, y, r, a) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  };
  blob(64, 70, 46, 0.85);
  blob(42, 62, 30, 0.8);
  blob(88, 60, 32, 0.8);
  blob(64, 52, 26, 0.7);
  _cloudTex = new THREE.CanvasTexture(c);
  return _cloudTex;
}

export function createSky(scene, theme, rng) {
  const group = new THREE.Group();

  const sunDir = new THREE.Vector3(...theme.sunDir).normalize();

  const domeGeo = new THREE.SphereGeometry(420, 24, 14);
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(theme.skyTop) },
      horizonColor: { value: new THREE.Color(theme.skyHorizon) },
      sunColor: { value: new THREE.Color(theme.sunColor) },
      sunDir: { value: sunDir.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w; // pin to far plane
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 topColor, horizonColor, sunColor, sunDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = pow(max(d.y, 0.0), 0.55);
        vec3 col = mix(horizonColor, topColor, h);
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * (pow(s, 900.0) * 1.6 + pow(s, 220.0) * 0.55 + pow(s, 7.0) * 0.16);
        // slight warm bounce near the ground line
        col = mix(col, horizonColor, pow(max(1.0 - abs(d.y), 0.0), 9.0) * 0.35);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  // clouds
  const clouds = [];
  const tex = cloudTexture();
  const count = 9;
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.5 + rng() * 0.3,
      depthWrite: false,
      fog: false,
      color: new THREE.Color(theme.cloudTint || "#ffffff"),
    });
    const s = new THREE.Sprite(mat);
    const ang = rng() * Math.PI * 2;
    const r = 130 + rng() * 160;
    s.position.set(Math.cos(ang) * r, 70 + rng() * 70, Math.sin(ang) * r);
    const sc = 46 + rng() * 60;
    s.scale.set(sc, sc * 0.42, 1);
    s.userData.drift = 0.6 + rng() * 0.9;
    group.add(s);
    clouds.push(s);
  }

  scene.add(group);

  return {
    sunDir,
    update(dt, camPos) {
      dome.position.copy(camPos);
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        c.position.x += c.userData.drift * dt;
        if (c.position.x - camPos.x > 320) c.position.x -= 640;
      }
    },
    dispose() {
      scene.remove(group);
      domeGeo.dispose();
      domeMat.dispose();
      for (const c of clouds) c.material.dispose();
    },
  };
}
