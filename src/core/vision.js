// Hands-free control layer: webcam -> MediaPipe FaceLandmarker -> head pose +
// expression gestures, mapped into the shared input state.
//
//   turn head        -> look (rate control: deadzone, then expo-curved speed)
//   lean left/right  -> strafe        (head x offset in cm from neutral)
//   lean in/out      -> forward/back  (face distance change from neutral)
//   open mouth       -> fire          (jawOpen blendshape, hysteretic)
//   raise brows      -> reload        (browInnerUp blendshape, cooldown)
//
// The model + wasm are lazy-loaded from CDN only when the player enables the
// mode, so the base bundle stays tiny. Neutral pose auto-calibrates from the
// first stable second of tracking and then drifts very slowly toward wherever
// the player naturally settles, so it self-heals posture drift mid-match.

import { settings } from "./settings.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// -- look (rate control) --
const YAW_DEADZONE = 0.07; // rad of head turn ignored around neutral
const YAW_RANGE = 0.30; // rad beyond deadzone for full turn speed
const YAW_MAX_RATE = 3.0; // rad/s view turn at full head turn
const PITCH_DEADZONE = 0.06;
const PITCH_RANGE = 0.26;
const PITCH_MAX_RATE = 1.7;
const LOOK_EXPO = 1.7; // >1 = gentle near center, fast at extremes
// Sign convention: mediapipe face matrix, camera space. If a platform ever
// reports mirrored axes, flip these two constants.
const YAW_SIGN = -1;
const PITCH_SIGN = -1;

// -- lean movement (cm from neutral) --
const STRAFE_DEADZONE = 3.0;
const STRAFE_FULL = 8.0;
const LEAN_DEADZONE = 4.0;
const LEAN_FULL = 10.0;
const STRAFE_SIGN = -1; // user leans right -> image/camera-space x decreases

// -- gestures --
const JAW_FIRE_ON = 0.5;
const JAW_FIRE_OFF = 0.3;
const BROW_RELOAD_ON = 0.65;
const RELOAD_COOLDOWN = 1.2; // s
// smile -> next weapon; pucker (kiss) -> SUNBURST ultimate. Both require the
// jaw closed so ordinary talking/firing can't misfire them, and both are
// edge-triggered with generous cooldowns.
const SMILE_SWITCH_ON = 0.62;
const SMILE_JAW_MAX = 0.3;
const SWITCH_COOLDOWN = 1.0; // s
const PUCKER_ULT_ON = 0.72;
const PUCKER_JAW_MAX = 0.25;
const ULT_COOLDOWN = 2.0; // s
const CALIB_FRAMES = 40; // ~1.3 s of samples for the neutral pose
const NEUTRAL_ADAPT_TAU = 12; // s; slow drift of neutral inside the deadzone

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// One-euro filter: jitter-free when still, low lag when moving.
class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.5, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.prev = null;
    this.dPrev = 0;
  }
  static alpha(dt, cutoff) {
    const r = 2 * Math.PI * cutoff * dt;
    return r / (r + 1);
  }
  filter(v, dt) {
    if (this.prev === null || dt <= 0) {
      this.prev = v;
      return v;
    }
    const dRaw = (v - this.prev) / dt;
    this.dPrev += OneEuro.alpha(dt, this.dCutoff) * (dRaw - this.dPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dPrev);
    this.prev += OneEuro.alpha(dt, cutoff) * (v - this.prev);
    return this.prev;
  }
  reset() {
    this.prev = null;
    this.dPrev = 0;
  }
}

function axisResponse(offset, deadzone, range, expo) {
  const mag = Math.abs(offset) - deadzone;
  if (mag <= 0) return 0;
  const t = Math.min(mag / range, 1);
  return Math.sign(offset) * Math.pow(t, expo);
}

class VisionControl {
  constructor() {
    this.input = null;
    this.active = false; // user wants the mode on
    this.running = false; // camera + model actually live
    this.status = "off";
    this._landmarker = null;
    this._video = null;
    this._stream = null;
    this._raf = 0;
    this._lastVideoTime = -1;

    // filtered pose + gesture scores (updated by the detect loop)
    this._pose = { yaw: 0, pitch: 0, x: 0, dist: 0 };
    this._haveFace = false;
    this._lostTime = 0;
    this._jaw = 0;
    this._brow = 0;
    this._fYaw = new OneEuro(1.1, 0.6);
    this._fPitch = new OneEuro(1.1, 0.6);
    this._fX = new OneEuro(1.0, 0.4);
    this._fDist = new OneEuro(0.9, 0.35);

    // neutral pose calibration
    this._neutral = null;
    this._calib = [];
    this._reloadCd = 0;
    this._firing = false;
    this._smile = 0;
    this._pucker = 0;
    this._switchCd = 0;
    this._ultCd = 0;

    this.onStatus = null; // (statusString) => void, for UI
  }

  init(input) {
    this.input = input;
    this._video = document.getElementById("cv-video");
    this._panel = document.getElementById("cv-panel");
    this._statusEl = document.getElementById("cv-status");
  }

  async enable() {
    if (this.active) return;
    this.active = true;
    this._setStatus("starting", "STARTING CAMERA…");
    if (this._panel) this._panel.hidden = false;
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
    } catch {
      this._setStatus("error", "CAMERA BLOCKED");
      this.active = false;
      return;
    }
    if (!this.active) {
      // user toggled off while the permission prompt was up
      for (const t of this._stream.getTracks()) t.stop();
      this._stream = null;
      return;
    }
    this._video.srcObject = this._stream;
    try {
      await this._video.play();
    } catch {
      /* autoplay policies; muted video should still start */
    }

    if (!this._landmarker) {
      this._setStatus("loading", "LOADING TRACKER…");
      try {
        const mp = await import("@mediapipe/tasks-vision");
        const files = await mp.FilesetResolver.forVisionTasks(WASM_URL);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
        try {
          this._landmarker = await mp.FaceLandmarker.createFromOptions(files, opts("GPU"));
        } catch {
          this._landmarker = await mp.FaceLandmarker.createFromOptions(files, opts("CPU"));
        }
      } catch {
        this._setStatus("error", "TRACKER FAILED TO LOAD");
        this.disable();
        return;
      }
    }
    if (!this.active) return;

    this.running = true;
    this.recenter();
    this._setStatus("nofase", "LOOK AT THE CAMERA");
    this._loop();
  }

  disable() {
    this.active = false;
    this.running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    if (this._stream) {
      for (const t of this._stream.getTracks()) t.stop();
      this._stream = null;
    }
    if (this._video) this._video.srcObject = null;
    this._clearInjected();
    // a failed start keeps the card up so the player can read why
    if (this.status !== "error") {
      if (this._panel) this._panel.hidden = true;
      this._setStatus("off", "");
    }
  }

  recenter() {
    this._neutral = null;
    this._calib = [];
    this._fYaw.reset();
    this._fPitch.reset();
    this._fX.reset();
    this._fDist.reset();
  }

  _setStatus(state, label) {
    this.status = state;
    if (this._statusEl && label !== undefined) this._statusEl.textContent = label;
    if (this._panel) {
      this._panel.classList.toggle("cv-live", state === "live");
      this._panel.classList.toggle("cv-fire", state === "fire");
      this._panel.classList.toggle("cv-err", state === "error" || state === "nofase");
    }
    if (this.onStatus) this.onStatus(state);
  }

  _clearInjected() {
    if (!this.input) return;
    this.input.cvMoveF = 0;
    this.input.cvMoveR = 0;
    this.input.cvFire = false;
    this._firing = false;
  }

  // detect loop, decoupled from the render loop (runs at camera rate)
  _loop() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const v = this._video;
    if (!v || v.readyState < 2 || v.currentTime === this._lastVideoTime) return;
    this._lastVideoTime = v.currentTime;

    let res;
    try {
      res = this._landmarker.detectForVideo(v, performance.now());
    } catch {
      return;
    }
    const now = performance.now() / 1000;
    const dt = Math.min(now - (this._lastDetect || now), 0.1) || 0.033;
    this._lastDetect = now;

    const mat = res.facialTransformationMatrixes?.[0]?.data;
    if (!mat) {
      this._haveFace = false;
      return;
    }
    this._haveFace = true;

    // head orientation from the face frame's z basis column (points out of
    // the face); position from the translation column, in cm.
    const zx = mat[8], zy = mat[9], zz = mat[10];
    const yawRaw = Math.atan2(zx, zz);
    const pitchRaw = Math.asin(Math.max(-1, Math.min(1, zy)));
    const x = mat[12];
    const dist = Math.hypot(mat[12], mat[13], mat[14]);

    this._pose.yaw = this._fYaw.filter(yawRaw, dt);
    this._pose.pitch = this._fPitch.filter(pitchRaw, dt);
    this._pose.x = this._fX.filter(x, dt);
    this._pose.dist = this._fDist.filter(dist, dt);

    let jaw = 0, brow = 0, smileL = 0, smileR = 0, pucker = 0;
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (cats) {
      for (const c of cats) {
        if (c.categoryName === "jawOpen") jaw = c.score;
        else if (c.categoryName === "browInnerUp") brow = c.score;
        else if (c.categoryName === "mouthSmileLeft") smileL = c.score;
        else if (c.categoryName === "mouthSmileRight") smileR = c.score;
        else if (c.categoryName === "mouthPucker") pucker = c.score;
      }
    }
    this._jaw = jaw;
    this._brow = brow;
    this._smile = (smileL + smileR) / 2;
    this._pucker = pucker;

    // neutral pose: median-ish capture over the first CALIB_FRAMES
    if (!this._neutral) {
      this._calib.push({ ...this._pose });
      if (this._calib.length >= CALIB_FRAMES) {
        const med = (key) => {
          const s = this._calib.map((c) => c[key]).sort((a, b) => a - b);
          return s[s.length >> 1];
        };
        this._neutral = { yaw: med("yaw"), pitch: med("pitch"), x: med("x"), dist: med("dist") };
        this._calib = [];
      }
    }
  }

  // Called once per render frame from the game loop with real dt: maps the
  // latest pose onto the shared input state. Look is injected only while
  // pointer-locked (i.e. actually in a match) so nothing accumulates in menus.
  tick(dt) {
    if (!this.running || !this.input) return;
    const inp = this.input;

    if (!this._haveFace || !this._neutral) {
      this._lostTime += dt;
      if (this._lostTime > 0.25) {
        this._clearInjected();
        if (this.status !== "nofase" && this.status !== "error")
          this._setStatus("nofase", this._neutral ? "FACE LOST" : "HOLD STILL — CALIBRATING…");
      }
      return;
    }
    this._lostTime = 0;

    const n = this._neutral;
    const dYaw = wrapAngle(this._pose.yaw - n.yaw);
    const dPitch = this._pose.pitch - n.pitch;
    const dX = this._pose.x - n.x;
    const dDist = n.dist - this._pose.dist; // + = leaned toward the screen

    // slow neutral drift while the player sits inside every deadzone
    if (
      Math.abs(dYaw) < YAW_DEADZONE &&
      Math.abs(dPitch) < PITCH_DEADZONE &&
      Math.abs(dX) < STRAFE_DEADZONE &&
      Math.abs(dDist) < LEAN_DEADZONE
    ) {
      const k = Math.min(dt / NEUTRAL_ADAPT_TAU, 1);
      n.yaw += dYaw * k;
      n.pitch += dPitch * k;
      n.x += dX * k;
      n.dist -= dDist * k;
    }

    // -- look --
    const sens = settings.headSens ?? 1;
    if (inp.locked) {
      const rx = axisResponse(dYaw, YAW_DEADZONE, YAW_RANGE, LOOK_EXPO) * YAW_MAX_RATE * sens;
      const ry = axisResponse(dPitch, PITCH_DEADZONE, PITCH_RANGE, LOOK_EXPO) * PITCH_MAX_RATE * sens;
      inp.cvAddLook(YAW_SIGN * rx * dt, PITCH_SIGN * ry * dt);
    }

    // -- movement --
    inp.cvMoveR = STRAFE_SIGN * axisResponse(dX, STRAFE_DEADZONE, STRAFE_FULL - STRAFE_DEADZONE, 1.2);
    inp.cvMoveF = axisResponse(dDist, LEAN_DEADZONE, LEAN_FULL - LEAN_DEADZONE, 1.2);

    // -- fire (hysteretic jaw) --
    if (!this._firing && this._jaw > JAW_FIRE_ON) this._firing = true;
    else if (this._firing && this._jaw < JAW_FIRE_OFF) this._firing = false;
    inp.cvFire = this._firing && inp.locked;

    // -- reload (brow raise, edge-triggered with cooldown) --
    this._reloadCd = Math.max(0, this._reloadCd - dt);
    if (this._brow > BROW_RELOAD_ON && this._reloadCd === 0 && inp.locked) {
      this._reloadCd = RELOAD_COOLDOWN;
      inp.pressVirtual("KeyR");
    }

    // -- weapon switch (smile with mouth closed) --
    this._switchCd = Math.max(0, this._switchCd - dt);
    if (this._smile > SMILE_SWITCH_ON && this._jaw < SMILE_JAW_MAX && this._switchCd === 0 && inp.locked) {
      this._switchCd = SWITCH_COOLDOWN;
      inp.pressVirtual("KeyV"); // session maps KeyV -> next weapon
    }

    // -- SUNBURST ultimate (pucker / kiss, mouth closed) --
    this._ultCd = Math.max(0, this._ultCd - dt);
    if (this._pucker > PUCKER_ULT_ON && this._jaw < PUCKER_JAW_MAX && this._ultCd === 0 && inp.locked) {
      this._ultCd = ULT_COOLDOWN;
      inp.pressVirtual("KeyX"); // session maps KeyX -> SUNBURST
    }

    this._setStatus(this._firing ? "fire" : "live", this._firing ? "FIRE" : "TRACKING");
  }
}

export const vision = new VisionControl();
