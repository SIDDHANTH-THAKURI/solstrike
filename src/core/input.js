// Pointer-lock input: raw mouse deltas, key state, discrete action presses,
// wheel steps. Everything is polled by the game loop; discrete events go
// through small callback registries so UI and gameplay stay decoupled.

import { settings } from "./settings.js";

class InputManager {
  constructor() {
    this.keys = new Set();
    this.mouse = [false, false, false];
    this._dx = 0;
    this._dy = 0;
    this._wheel = 0;
    this.locked = false;
    this.wantLock = false; // game wants lock (used to detect Esc-pause)
    this._pressHandlers = new Map(); // code -> Set<fn>
    this._lockChangeHandlers = new Set();
    this.canvas = null;
    // hands-free (vision) injected state: analog move, held fire, look deltas
    this.cvMoveF = 0;
    this.cvMoveR = 0;
    this.cvFire = false;
    this._cvdx = 0;
    this._cvdy = 0;
  }

  // vision layer feeds look deltas already in radians (post-sensitivity)
  cvAddLook(dx, dy) {
    this._cvdx += dx;
    this._cvdy += dy;
  }

  // fire discrete-press handlers for a virtual key (vision gestures)
  pressVirtual(code) {
    const hs = this._pressHandlers.get(code);
    if (hs) for (const fn of hs) fn({ code, virtual: true });
  }

  init(canvas) {
    this.canvas = canvas;

    document.addEventListener("keydown", (e) => {
      // keep browser shortcuts working when not in game
      if (this.locked) {
        // block the combos game keys collide with: Ctrl/Shift are held as
        // crouch/walk modifiers, so almost any Ctrl+/Shift+key the player
        // fires alongside them would otherwise trigger a browser shortcut
        // (new tab, close tab, devtools, find, view-source, print, ...).
        if (
          e.code === "Tab" ||
          e.code === "Space" ||
          e.code === "Slash" ||
          e.code === "Quote" ||
          e.key === "Control" ||
          e.key === "Shift" ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          e.metaKey ||
          e.code === "F5" ||
          e.code === "F6" ||
          e.code === "F11" ||
          e.code === "F12" ||
          e.code === "Backspace"
        ) {
          e.preventDefault();
        }
      }
      if (e.repeat) return;
      this.keys.add(e.code);
      const hs = this._pressHandlers.get(e.code);
      if (hs) for (const fn of hs) fn(e);
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouse.fill(false);
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this._dx += e.movementX;
      this._dy += e.movementY;
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button <= 2) this.mouse[e.button] = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button <= 2) this.mouse[e.button] = false;
    });
    document.addEventListener("contextmenu", (e) => {
      if (this.locked) e.preventDefault();
    });
    document.addEventListener(
      "wheel",
      (e) => {
        if (!this.locked) return;
        this._wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false }
    );

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) {
        this._dx = 0;
        this._dy = 0;
      } else {
        this.mouse.fill(false);
        this.keys.clear();
      }
      for (const fn of this._lockChangeHandlers) fn(this.locked);
    });
    document.addEventListener("pointerlockerror", () => {
      for (const fn of this._lockChangeHandlers) fn(false);
    });
  }

  async requestLock() {
    this.wantLock = true;
    if (this.simulate) {
      // automated-test mode: no real pointer lock available (headless)
      this.locked = true;
      for (const fn of this._lockChangeHandlers) fn(true);
      return true;
    }
    if (this.locked) return true;
    try {
      // fullscreen + pointer-lock together makes Chrome/Edge suppress almost
      // all in-browser keyboard shortcuts (new tab, close tab, devtools,
      // find, ...) while playing. Best-effort: ignore if blocked/unsupported.
      if (document.fullscreenElement == null && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      // unadjustedMovement = raw input, no OS acceleration (Valorant feel)
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) {
        await p.catch(async () => {
          await this.canvas.requestPointerLock();
        });
      }
      return true;
    } catch {
      try {
        this.canvas.requestPointerLock();
        return true;
      } catch {
        return false;
      }
    }
  }

  releaseLock() {
    this.wantLock = false;
    if (this.simulate) {
      this.locked = false;
      for (const fn of this._lockChangeHandlers) fn(false);
      return;
    }
    if (document.pointerLockElement) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  // test-drive helpers (used by the automated smoke suite)
  simLook(dx, dy) {
    this._dx += dx;
    this._dy += dy;
  }
  simKey(code, down) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }
  simMouse(btn, down) {
    this.mouse[btn] = down;
  }

  // Discrete key press subscription (fires on keydown, not repeat).
  onPress(code, fn) {
    if (!this._pressHandlers.has(code)) this._pressHandlers.set(code, new Set());
    this._pressHandlers.get(code).add(fn);
    return () => this._pressHandlers.get(code)?.delete(fn);
  }

  onLockChange(fn) {
    this._lockChangeHandlers.add(fn);
    return () => this._lockChangeHandlers.delete(fn);
  }

  // Per-frame look delta in radians, sensitivity applied. adsScale shrinks
  // sensitivity while aiming.
  consumeLook(adsScale = 1) {
    const k = 0.0021 * settings.sens * adsScale;
    // cv deltas are radians already; only ADS slowdown applies to them
    const out = { x: this._dx * k + this._cvdx * adsScale, y: this._dy * k + this._cvdy * adsScale };
    this._dx = 0;
    this._dy = 0;
    this._cvdx = 0;
    this._cvdy = 0;
    return out;
  }

  consumeWheel() {
    const w = this._wheel;
    this._wheel = 0;
    return w;
  }

  down(code) {
    return this.keys.has(code);
  }

  get moveForward() {
    const kb = (this.down("KeyW") ? 1 : 0) - (this.down("KeyS") ? 1 : 0);
    return Math.max(-1, Math.min(1, kb + this.cvMoveF));
  }
  get moveRight() {
    const kb = (this.down("KeyD") ? 1 : 0) - (this.down("KeyA") ? 1 : 0);
    return Math.max(-1, Math.min(1, kb + this.cvMoveR));
  }
  get firing() {
    return this.mouse[0] || this.cvFire;
  }
  get aiming() {
    return this.mouse[2];
  }
  get walking() {
    return this.down("ShiftLeft") || this.down("ShiftRight");
  }
  get crouching() {
    return this.down("ControlLeft") || this.down("ControlRight") || this.down("KeyC");
  }
  get jumping() {
    return this.down("Space");
  }
}

export const input = new InputManager();
