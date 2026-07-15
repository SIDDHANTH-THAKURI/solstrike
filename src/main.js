// SOLSTRIKE entry point. Owns the engine, menu/attract mode, session
// lifecycle, pause flow and auto quality scaling.

import * as THREE from "three";
import { Engine, deepDispose } from "./core/engine.js";
import { input } from "./core/input.js";
import { audio } from "./core/audio.js";
import { settings, onSettingsChange, setSetting } from "./core/settings.js";
import { buildMap } from "./world/mapgen.js";
import { HUD } from "./ui/hud.js";
import { Menus } from "./ui/menus.js";
import { Session } from "./game/session.js";
import { vision } from "./core/vision.js";

const canvas = document.getElementById("game-canvas");

let engine;
try {
  engine = new Engine(canvas);
} catch (err) {
  document.getElementById("fatal").hidden = false;
  document.getElementById("fatal-msg").textContent =
    "WebGL could not start. Update your graphics drivers or try another browser. (" + (err?.message ?? err) + ")";
  throw err;
}

input.init(canvas);
const hud = new HUD();

// ---------------------------------------------------------------- attract

let attract = null;

function buildAttract() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 600);
  const map = buildMap(scene, "random", (Math.random() * 2 ** 31) | 0);
  engine.configureLight(map.lights.dir);
  attract = { scene, camera, map, t: Math.random() * 100 };
}

function disposeAttract() {
  if (!attract) return;
  attract.map.dispose();
  deepDispose(attract.scene);
  attract = null;
}

// ---------------------------------------------------------------- session

let session = null;
let paused = false;
let lastMatchOpts = null;

function startMatch(map, difficulty) {
  lastMatchOpts = { map, difficulty };
  menus.busy("Building arena…");
  menus.hideAll();
  audio.ensure();
  audio.stopMusic();

  requestAnimationFrame(() => {
    disposeAttract();
    if (session) {
      session.dispose();
      session = null;
    }
    session = new Session(engine, hud, {
      map,
      difficulty,
      onEnd: (result) => {
        paused = false;
        hud.hide();
        menus.showEnd(result);
        audio.startMusic("menu");
      },
    });
    paused = false;
    menus.busy(null);
    input.requestLock();
  });
}

function quitToMenu() {
  if (session) {
    session.dispose();
    session = null;
  }
  paused = false;
  input.releaseLock();
  hud.hide();
  buildAttract();
  menus.show("menu");
  audio.ensure();
  audio.startMusic("menu");
}

const menus = new Menus({
  onStart: (map, diff) => startMatch(map, diff),
  onResume: async () => {
    await input.requestLock();
  },
  onQuit: () => quitToMenu(),
  onRematch: () => startMatch(lastMatchOpts.map, lastMatchOpts.difficulty),
});

// pause on pointer-lock loss mid-match
input.onLockChange((locked) => {
  if (!session || session.state === "over") return;
  if (locked) {
    paused = false;
    session.setPaused(false);
    menus.hideAll();
    hud.show();
  } else {
    paused = true;
    session.setPaused(true);
    menus.setPauseProgress(`ROUND ${session.round} OF 13 · ${session.stats.kills} KILLS`);
    menus.show("pause");
  }
});

// ---------------------------------------------------------------- quality

function applyQualitySetting() {
  const q = settings.quality === "auto" ? autoTier : settings.quality;
  engine.applyQuality(q);
  const map = session?.map || attract?.map;
  if (map) engine.configureLight(map.lights.dir);
}

let autoTier = "high";
let lowFpsStreak = 0;
engine.onFps = (fps) => {
  hud.setFps(fps);
  if (settings.quality !== "auto" || !session || paused) return;
  if (fps < 47) {
    lowFpsStreak++;
    if (lowFpsStreak >= 5) {
      lowFpsStreak = 0;
      if (autoTier === "high") autoTier = "medium";
      else if (autoTier === "medium") autoTier = "low";
      else return;
      applyQualitySetting();
    }
  } else {
    lowFpsStreak = 0;
  }
};

// ------------------------------------------------------------- hands-free

vision.init(input);
vision.onStatus = (state) => {
  // camera/model failed to start: flip the setting back off (the error card
  // stays visible so the player can read why)
  if (state === "error" && settings.handsFree) {
    setSetting("handsFree", false);
    const el = document.getElementById("set-cv");
    if (el) el.checked = false;
  }
};
if (settings.handsFree) vision.enable();
input.onPress("KeyN", () => vision.recenter());

onSettingsChange((k) => {
  if (k === "handsFree") {
    if (settings.handsFree) vision.enable();
    else vision.disable();
  }
  if (k === "quality") applyQualitySetting();
  if (k === "fov" && session) {
    session.camera.fov = settings.fov;
    session.camera.updateProjectionMatrix();
  }
});
applyQualitySetting();

// ---------------------------------------------------------------- resize

engine.onResize = (w, h) => {
  if (session) session.resize(w, h);
  if (attract) {
    attract.camera.aspect = w / h;
    attract.camera.updateProjectionMatrix();
  }
};

// ---------------------------------------------------------------- loop

engine.start((dt) => {
  vision.tick(dt);
  if (session) {
    session.update(dt);
  } else if (attract) {
    attract.t += dt * 0.05;
    const r = 27;
    const cam = attract.camera;
    cam.position.set(Math.cos(attract.t) * r, 12.5 + Math.sin(attract.t * 2.3) * 1.2, Math.sin(attract.t) * r);
    cam.lookAt(0, 1.5, 0);
    attract.map.skyUpdate(dt, cam.position);
    const rend = engine.renderer;
    rend.clear(true, true, false);
    rend.render(attract.scene, cam);
  }
});

// ---------------------------------------------------------------- boot

buildAttract();
menus.show("menu");

// music can only start after a user gesture
document.addEventListener(
  "pointerdown",
  function firstGesture() {
    audio.ensure();
    if (!session) audio.startMusic("menu");
    document.removeEventListener("pointerdown", firstGesture);
  },
  { once: true }
);

// automation/test hooks
window.__SOL = {
  engine,
  input,
  get session() {
    return session;
  },
  startMatch,
  quitToMenu,
  settings,
  setSetting,
};
