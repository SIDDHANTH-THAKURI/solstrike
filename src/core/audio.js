// Procedural audio engine. Every sound is synthesized in WebAudio at play
// time — zero downloaded assets, instant load, and easy per-weapon variation.
// Buses: master -> sfx / music / ui. World sounds are panned + attenuated
// against the listener (camera) each call.

import { settings, onSettingsChange } from "./settings.js";
import { clamp } from "./utils.js";

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.music = null;
    this.ui = null;
    this.ambient = null;
    this._noiseBuf = null;
    this._listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 }; // pos + right vector
    this._musicTimer = null;
    this._musicMode = null;
    this._intensity = 0;
    this._padOscs = [];
    this._birdTimer = null;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.connect(c.destination);
    this.sfx = c.createGain();
    this.sfx.connect(this.master);
    this.music = c.createGain();
    this.music.connect(this.master);
    this.ui = c.createGain();
    this.ui.connect(this.master);
    this.ambient = c.createGain();
    this.ambient.connect(this.master);

    // shared delay/echo send for music sparkle + sniper tail
    this.echo = c.createDelay(0.6);
    this.echo.delayTime.value = 0.24;
    this.echoFb = c.createGain();
    this.echoFb.gain.value = 0.32;
    this.echoOut = c.createGain();
    this.echoOut.gain.value = 0.5;
    this.echo.connect(this.echoFb);
    this.echoFb.connect(this.echo);
    this.echo.connect(this.echoOut);
    this.echoOut.connect(this.master);

    // 2s white noise buffer reused by every noise-based sound
    const len = c.sampleRate * 2;
    this._noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this._applyVolumes();
    onSettingsChange((k) => {
      if (k === "master" || k === "sfx" || k === "music") this._applyVolumes();
    });

    this._startAmbient();
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const m = settings.master / 100;
    this.master.gain.value = m * m; // perceptual-ish curve
    this.sfx.gain.value = settings.sfx / 100;
    this.ui.gain.value = (settings.sfx / 100) * 0.8;
    this.music.gain.value = (settings.music / 100) * 0.5;
    this.ambient.gain.value = (settings.music / 100) * 0.4;
  }

  setListener(pos, right) {
    this._listener.x = pos.x;
    this._listener.y = pos.y;
    this._listener.z = pos.z;
    this._listener.rx = right.x;
    this._listener.rz = right.z;
  }

  // pan/volume for a world position; returns null if inaudible
  _spatial(pos, range = 42) {
    const L = this._listener;
    const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > range) return null;
    const vol = Math.pow(1 - d / range, 1.4);
    let pan = 0;
    if (d > 0.6) pan = clamp((dx * L.rx + dz * L.rz) / d, -1, 1) * 0.75;
    return { vol, pan };
  }

  // ---- primitive builders -------------------------------------------------

  _out(bus, pan, when, echoSend = 0) {
    const c = this.ctx;
    const g = c.createGain();
    let node = g;
    if (pan) {
      const p = c.createStereoPanner();
      p.pan.setValueAtTime(pan, when);
      g.connect(p);
      p.connect(bus);
    } else {
      g.connect(bus);
    }
    if (echoSend > 0) {
      const s = c.createGain();
      s.gain.value = echoSend;
      g.connect(s);
      s.connect(this.echo);
    }
    return node;
  }

  _noise({ bus = this.sfx, dur = 0.1, type = "lowpass", f0 = 1000, f1 = 0, q = 1, vol = 0.5, attack = 0.001, pan = 0, when = 0, echoSend = 0 }) {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const fl = c.createBiquadFilter();
    fl.type = type;
    fl.frequency.setValueAtTime(f0, t);
    if (f1 > 0) fl.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    fl.Q.value = q;
    const g = this._out(bus, pan, t, echoSend);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl);
    fl.connect(g);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  _tone({ bus = this.sfx, type = "sine", f0 = 440, f1 = 0, dur = 0.15, vol = 0.4, attack = 0.002, pan = 0, when = 0, echoSend = 0 }) {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 > 0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    const g = this._out(bus, pan, t, echoSend);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ---- UI -----------------------------------------------------------------

  uiHover() {
    this._tone({ bus: this.ui, type: "sine", f0: 700, dur: 0.05, vol: 0.08 });
  }
  uiClick() {
    this._tone({ bus: this.ui, type: "triangle", f0: 900, f1: 620, dur: 0.09, vol: 0.2 });
    this._noise({ bus: this.ui, dur: 0.03, type: "highpass", f0: 3000, vol: 0.08 });
  }

  // ---- weapons ------------------------------------------------------------

  shot(kind, pos = null) {
    if (!this.ctx) return;
    let sp = { vol: 1, pan: 0 };
    if (pos) {
      const s = this._spatial(pos, 55);
      if (!s) return;
      sp = s;
    }
    const v = sp.vol, pan = sp.pan;
    switch (kind) {
      case "vespa": // pistol: dry snap
        this._noise({ dur: 0.05, type: "highpass", f0: 2400, vol: 0.5 * v, pan });
        this._noise({ dur: 0.11, type: "lowpass", f0: 1500, f1: 300, vol: 0.55 * v, pan });
        this._tone({ type: "sine", f0: 190, f1: 70, dur: 0.09, vol: 0.5 * v, pan });
        break;
      case "havoc": // rifle: punchy mid crack
        this._noise({ dur: 0.04, type: "highpass", f0: 3200, vol: 0.5 * v, pan });
        this._noise({ dur: 0.14, type: "bandpass", f0: 900, q: 0.8, vol: 0.62 * v, pan });
        this._tone({ type: "sine", f0: 150, f1: 55, dur: 0.12, vol: 0.62 * v, pan });
        break;
      case "mauler": // shotgun: wide boom
        this._noise({ dur: 0.26, type: "lowpass", f0: 2600, f1: 220, vol: 0.85 * v, pan });
        this._tone({ type: "sine", f0: 110, f1: 42, dur: 0.24, vol: 0.8 * v, pan });
        this._noise({ dur: 0.06, type: "highpass", f0: 2000, vol: 0.4 * v, pan });
        break;
      case "longbow": // sniper: huge crack + echo tail
        this._noise({ dur: 0.06, type: "highpass", f0: 2600, vol: 0.7 * v, pan, echoSend: 0.5 });
        this._noise({ dur: 0.3, type: "bandpass", f0: 700, q: 0.6, vol: 0.8 * v, pan, echoSend: 0.4 });
        this._tone({ type: "sine", f0: 130, f1: 40, dur: 0.3, vol: 0.75 * v, pan });
        break;
      case "ogre": // rocket launch: thump + whoosh
        this._tone({ type: "sine", f0: 95, f1: 38, dur: 0.3, vol: 0.85 * v, pan });
        this._noise({ dur: 0.5, type: "bandpass", f0: 500, f1: 1400, q: 1.4, vol: 0.4 * v, pan });
        break;
      case "bot": // spectre blaster: synthetic zap
        this._tone({ type: "square", f0: 800, f1: 240, dur: 0.09, vol: 0.22 * v, pan });
        this._noise({ dur: 0.07, type: "bandpass", f0: 1800, q: 2, vol: 0.2 * v, pan });
        break;
    }
  }

  dryFire() {
    this._tone({ type: "square", f0: 420, f1: 300, dur: 0.05, vol: 0.14 });
  }

  reloadTick(stage) {
    // 0: mag out, 1: mag in, 2: rack/slide
    if (stage === 0) {
      this._noise({ dur: 0.05, type: "bandpass", f0: 900, q: 3, vol: 0.3 });
      this._tone({ type: "triangle", f0: 320, f1: 210, dur: 0.06, vol: 0.18 });
    } else if (stage === 1) {
      this._noise({ dur: 0.05, type: "bandpass", f0: 1300, q: 3, vol: 0.34 });
      this._tone({ type: "triangle", f0: 460, f1: 350, dur: 0.05, vol: 0.2 });
    } else {
      this._noise({ dur: 0.06, type: "highpass", f0: 2200, vol: 0.35 });
      this._tone({ type: "square", f0: 700, f1: 520, dur: 0.05, vol: 0.15 });
    }
  }

  switchWoosh() {
    this._noise({ dur: 0.12, type: "bandpass", f0: 600, f1: 1600, q: 1.5, vol: 0.16 });
  }

  // ---- feedback -----------------------------------------------------------

  hitmark() {
    this._tone({ bus: this.ui, type: "square", f0: 2100, f1: 1700, dur: 0.045, vol: 0.16 });
  }
  headshot() {
    this._tone({ bus: this.ui, type: "sine", f0: 1320, dur: 0.07, vol: 0.24 });
    this._tone({ bus: this.ui, type: "sine", f0: 1980, dur: 0.1, vol: 0.2, when: 0.045 });
  }
  killConfirm() {
    this._tone({ bus: this.ui, type: "triangle", f0: 880, dur: 0.07, vol: 0.2 });
    this._tone({ bus: this.ui, type: "triangle", f0: 1174, dur: 0.09, vol: 0.2, when: 0.06 });
  }
  hurt() {
    this._noise({ dur: 0.12, type: "lowpass", f0: 900, f1: 250, vol: 0.5 });
    this._tone({ type: "sawtooth", f0: 190, f1: 120, dur: 0.12, vol: 0.24 });
  }
  shieldBreak() {
    this._noise({ dur: 0.2, type: "highpass", f0: 1600, vol: 0.4 });
    this._tone({ type: "square", f0: 620, f1: 240, dur: 0.18, vol: 0.2 });
  }
  whiz(pan) {
    this._noise({ dur: 0.09, type: "bandpass", f0: 3400, f1: 1400, q: 4, vol: 0.22, pan });
  }

  footstep(run, self = true, pos = null) {
    let vol = self ? (run ? 0.16 : 0.07) : 0.3;
    let pan = 0;
    if (pos) {
      const s = this._spatial(pos, 26);
      if (!s) return;
      vol *= s.vol;
      pan = s.pan;
    }
    const f = self ? 480 : 300;
    this._noise({ dur: 0.07, type: "lowpass", f0: f + Math.random() * 120, f1: 120, vol, pan });
  }

  jumpLand(hard) {
    this._noise({ dur: hard ? 0.14 : 0.08, type: "lowpass", f0: 500, f1: 100, vol: hard ? 0.34 : 0.18 });
  }

  explosion(pos = null) {
    let v = 1, pan = 0;
    if (pos) {
      const s = this._spatial(pos, 70);
      if (!s) return;
      v = 0.35 + s.vol * 0.65;
      pan = s.pan;
    }
    this._noise({ dur: 0.85, type: "lowpass", f0: 900, f1: 60, vol: 0.95 * v, pan, echoSend: 0.3 });
    this._tone({ type: "sine", f0: 70, f1: 30, dur: 0.7, vol: 0.9 * v, pan });
    this._noise({ dur: 0.25, type: "highpass", f0: 1400, vol: 0.35 * v, pan });
    // crackle tail
    for (let i = 0; i < 4; i++) {
      this._noise({ dur: 0.05, type: "bandpass", f0: 800 + Math.random() * 2000, q: 3, vol: 0.16 * v, pan, when: 0.15 + i * 0.09 });
    }
  }

  rocketLoop() {
    // short whoosh reused as flight noise, retriggered by projectile
    this._noise({ dur: 0.3, type: "bandpass", f0: 700, q: 1, vol: 0.06 });
  }

  pickup(kind) {
    if (kind === "health") {
      this._tone({ bus: this.ui, type: "sine", f0: 620, dur: 0.09, vol: 0.22 });
      this._tone({ bus: this.ui, type: "sine", f0: 930, dur: 0.12, vol: 0.22, when: 0.07 });
    } else {
      this._noise({ bus: this.ui, dur: 0.06, type: "bandpass", f0: 1500, q: 2, vol: 0.3 });
      this._tone({ bus: this.ui, type: "triangle", f0: 500, dur: 0.08, vol: 0.2, when: 0.04 });
    }
  }

  spawnBeam(pos) {
    let v = 0.5, pan = 0;
    if (pos) {
      const s = this._spatial(pos, 60);
      if (!s) return;
      v = s.vol * 0.6;
      pan = s.pan;
    }
    this._tone({ type: "sawtooth", f0: 180, f1: 900, dur: 0.35, vol: 0.14 * v, pan });
    this._tone({ type: "sine", f0: 1400, f1: 2400, dur: 0.25, vol: 0.1 * v, pan, when: 0.1 });
  }

  botDeath(pos) {
    let v = 1, pan = 0;
    if (pos) {
      const s = this._spatial(pos, 45);
      if (!s) return;
      v = s.vol;
      pan = s.pan;
    }
    this._noise({ dur: 0.2, type: "bandpass", f0: 700, f1: 200, q: 1, vol: 0.5 * v, pan });
    this._tone({ type: "square", f0: 500, f1: 90, dur: 0.28, vol: 0.25 * v, pan });
    this._noise({ dur: 0.1, type: "highpass", f0: 2500, vol: 0.3 * v, pan });
  }

  // ---- stingers -----------------------------------------------------------

  stinger(kind) {
    const notes = {
      roundStart: [[440, 0], [660, 0.12]],
      roundClear: [[523, 0], [659, 0.1], [784, 0.2], [1046, 0.32]],
      lastEnemy: [[880, 0], [880, 0.14]],
      victory: [[523, 0], [659, 0.12], [784, 0.24], [1046, 0.36], [1318, 0.52]],
      defeat: [[392, 0], [330, 0.18], [262, 0.36], [196, 0.6]],
    }[kind];
    if (!notes) return;
    for (const [f, w] of notes) {
      this._tone({ bus: this.music, type: "triangle", f0: f, dur: 0.35, vol: 0.3, when: w, echoSend: 0.35 });
      this._tone({ bus: this.music, type: "sine", f0: f / 2, dur: 0.4, vol: 0.2, when: w });
    }
  }

  countBeep(final) {
    this._tone({ bus: this.ui, type: "sine", f0: final ? 1046 : 660, dur: final ? 0.2 : 0.09, vol: 0.25 });
  }

  // ---- SUNBURST ultimate ----------------------------------------------------

  ultReady() {
    // shimmering major rise — unmistakable "it's up"
    for (const [f, w] of [[784, 0], [988, 0.09], [1318, 0.18], [1568, 0.3]]) {
      this._tone({ bus: this.ui, type: "sine", f0: f, dur: 0.3, vol: 0.22, when: w, echoSend: 0.5 });
    }
    this._noise({ bus: this.ui, dur: 0.5, type: "highpass", f0: 6000, vol: 0.08, when: 0.1 });
  }

  ultDenied() {
    this._tone({ bus: this.ui, type: "square", f0: 220, f1: 160, dur: 0.12, vol: 0.14 });
  }

  ultCharge() {
    // rising whine + swelling noise across the telegraph window
    if (!this.ctx) return;
    this._tone({ type: "sawtooth", f0: 160, f1: 1500, dur: 0.95, vol: 0.2, attack: 0.1, echoSend: 0.3 });
    this._tone({ type: "sine", f0: 320, f1: 3000, dur: 0.95, vol: 0.12, attack: 0.25 });
    this._noise({ dur: 0.95, type: "bandpass", f0: 500, f1: 4000, q: 1.2, vol: 0.16, attack: 0.35 });
  }

  ultBlast(pos = null) {
    let v = 1, pan = 0;
    if (pos) {
      const s = this._spatial(pos, 90);
      if (s) {
        v = 0.5 + s.vol * 0.5;
        pan = s.pan;
      }
    }
    // huge layered detonation: white crack, chest thump, long sub roll
    this._noise({ dur: 0.1, type: "highpass", f0: 2000, vol: 0.9 * v, pan });
    this._noise({ dur: 1.3, type: "lowpass", f0: 1200, f1: 45, vol: 1.0 * v, pan, echoSend: 0.4 });
    this._tone({ type: "sine", f0: 88, f1: 26, dur: 1.4, vol: 1.0 * v, pan });
    this._tone({ type: "sine", f0: 44, f1: 22, dur: 1.8, vol: 0.7 * v, when: 0.12 });
    // crackle + shimmer tail
    for (let i = 0; i < 7; i++) {
      this._noise({ dur: 0.06, type: "bandpass", f0: 700 + Math.random() * 2600, q: 3, vol: 0.2 * v, pan, when: 0.2 + i * 0.11 });
    }
    for (const [f, w] of [[1568, 0.5], [1318, 0.72], [988, 0.95]]) {
      this._tone({ type: "sine", f0: f, dur: 0.4, vol: 0.09 * v, when: w, echoSend: 0.6 });
    }
  }

  // ---- ambient + music ----------------------------------------------------

  _startAmbient() {
    const c = this.ctx;
    // wind: looped noise through slowly wandering bandpass
    const src = c.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 420;
    f.Q.value = 0.5;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = c.createGain();
    lfoG.gain.value = 180;
    lfo.connect(lfoG);
    lfoG.connect(f.frequency);
    const g = c.createGain();
    g.gain.value = 0.05;
    src.connect(f);
    f.connect(g);
    g.connect(this.ambient);
    src.start();
    lfo.start();

    // occasional birds
    const chirp = () => {
      if (this.ctx.state === "running" && this._musicMode !== "combat") {
        const base = 2200 + Math.random() * 1400;
        for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
          this._tone({ bus: this.ambient, type: "sine", f0: base + Math.random() * 300, f1: base * 1.3, dur: 0.07, vol: 0.12, when: i * 0.11, pan: Math.random() * 1.4 - 0.7 });
        }
      }
      this._birdTimer = setTimeout(chirp, 3500 + Math.random() * 6000);
    };
    this._birdTimer = setTimeout(chirp, 2000);
  }

  setIntensity(v) {
    this._intensity = clamp(v, 0, 1);
  }

  startMusic(mode) {
    if (!this.ctx) return;
    if (this._musicMode === mode) return;
    this.stopMusic();
    this._musicMode = mode;
    if (mode === "menu") {
      this._startPads();
      return;
    }
    // combat: 16-step sequencer with lookahead scheduling
    const c = this.ctx;
    const tempo = 118;
    const stepDur = 60 / tempo / 4;
    let step = 0;
    let next = c.currentTime + 0.1;
    const bassLine = [110, 110, 87.3, 98]; // A F G roots per bar
    let bar = 0;
    const penta = [440, 523.25, 587.33, 659.25, 783.99];
    this._musicTimer = setInterval(() => {
      if (!this.ctx || this._musicMode !== "combat") return;
      while (next < c.currentTime + 0.22) {
        const s = step % 16;
        const inten = this._intensity;
        const when = next - c.currentTime;
        // hats
        if (s % 2 === 0) {
          this._noise({ bus: this.music, dur: 0.03, type: "highpass", f0: 8000, vol: s % 4 === 0 ? 0.1 : 0.05, when });
        }
        // kick
        if (s === 0 || s === 8 || (inten > 0.55 && s === 14)) {
          this._tone({ bus: this.music, type: "sine", f0: 130, f1: 44, dur: 0.16, vol: 0.4, when });
        }
        // bass pluck
        if (s === 0 || s === 6 || s === 12) {
          this._tone({ bus: this.music, type: "triangle", f0: bassLine[bar % 4], dur: 0.22, vol: 0.24, when });
        }
        // arp sparkle scales with intensity
        if (inten > 0.35 && s % 2 === 1 && Math.random() < 0.35 + inten * 0.4) {
          this._tone({ bus: this.music, type: "square", f0: penta[Math.floor(Math.random() * penta.length)], dur: 0.09, vol: 0.05 + inten * 0.06, when, echoSend: 0.5 });
        }
        step++;
        if (step % 16 === 0) bar++;
        next += stepDur;
      }
    }, 90);
  }

  _startPads() {
    const c = this.ctx;
    const chords = [
      [220, 261.6, 329.6],
      [174.6, 220, 261.6],
      [196, 246.9, 293.7],
      [164.8, 220, 246.9],
    ];
    let idx = 0;
    const playChord = () => {
      if (this._musicMode !== "menu") return;
      const ch = chords[idx % chords.length];
      idx++;
      for (const f of ch) {
        for (const det of [-3, 3]) {
          const o = c.createOscillator();
          o.type = "sawtooth";
          o.frequency.value = f;
          o.detune.value = det;
          const fl = c.createBiquadFilter();
          fl.type = "lowpass";
          fl.frequency.value = 620;
          const g = c.createGain();
          const t = c.currentTime;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.035, t + 1.6);
          g.gain.setValueAtTime(0.035, t + 3.4);
          g.gain.linearRampToValueAtTime(0.0001, t + 5);
          o.connect(fl);
          fl.connect(g);
          g.connect(this.music);
          o.start(t);
          o.stop(t + 5.1);
          this._padOscs.push(o);
        }
      }
      // gentle pluck on top
      this._tone({ bus: this.music, type: "triangle", f0: ch[2] * 2, dur: 0.5, vol: 0.05, when: 1.8, echoSend: 0.6 });
      this._musicTimer = setTimeout(playChord, 4600);
    };
    playChord();
  }

  stopMusic() {
    if (this._musicTimer) {
      clearInterval(this._musicTimer);
      clearTimeout(this._musicTimer);
      this._musicTimer = null;
    }
    this._musicMode = null;
    this._padOscs.length = 0;
  }
}

export const audio = new AudioEngine();
