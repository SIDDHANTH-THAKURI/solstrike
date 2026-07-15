// In-game HUD: all DOM. Pools for damage numbers / direction arcs, killfeed
// row management, announcer with hold timers, crosshair spread + hitmarker.

import * as THREE from "three";
import { settings, onSettingsChange } from "../core/settings.js";
import { formatTime } from "../core/utils.js";

const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3();

export class HUD {
  constructor() {
    this.root = $("hud");
    this.elRound = $("hud-round");
    this.elEnemies = $("hud-enemies");
    this.elTimer = $("hud-timer");
    this.elHp = $("hud-hp");
    this.barHp = $("bar-hp");
    this.barShield = $("bar-shield");
    this.elWeapon = $("hud-weapon");
    this.elMag = $("hud-mag");
    this.elReserve = $("hud-reserve");
    this.rail = $("weapon-rail");
    this.killfeed = $("killfeed");
    this.announcer = $("announcer");
    this.announceMain = $("announce-main");
    this.announceSub = $("announce-sub");
    this.crosshair = $("crosshair");
    this.hitmarker = $("hitmarker");
    this.vHurt = $("vignette-hurt");
    this.vLow = $("vignette-low");
    this.scope = $("scope-overlay");
    this.toast = $("pickup-toast");
    this.fpsBadge = $("fps-badge");
    this.arcs = $("dmg-arcs");
    this.scoreboardEl = $("scoreboard");
    this.liveStats = $("live-stats");

    this._hurtT = 0;
    this._announceToken = 0;
    this._spreadPx = 0;

    // damage number pool
    this.dmgPool = [];
    const dmgRoot = $("dmg-numbers");
    for (let i = 0; i < 18; i++) {
      const el = document.createElement("div");
      el.className = "dmg-num";
      el.style.display = "none";
      dmgRoot.appendChild(el);
      this.dmgPool.push({ el, active: false, wx: 0, wy: 0, wz: 0, t: 0, drift: 0 });
    }
    this._dmgIdx = 0;

    // arc pool
    this.arcPool = [];
    for (let i = 0; i < 6; i++) {
      const el = document.createElement("div");
      el.className = "dmg-arc";
      el.style.display = "none";
      this.arcs.appendChild(el);
      this.arcPool.push(el);
    }
    this._arcIdx = 0;

    this.applyCrosshairSettings();
    onSettingsChange((k) => {
      if (k.startsWith("ch")) this.applyCrosshairSettings();
      if (k === "showFps") this.fpsBadge.hidden = !settings.showFps;
    });
  }

  applyCrosshairSettings() {
    const st = this.crosshair.style;
    st.setProperty("--ch-color", settings.chColor);
    st.setProperty("--ch-size", settings.chSize + "px");
    st.setProperty("--ch-gap", settings.chGap + this._spreadPx + "px");
    this.crosshair.classList.toggle("no-dot", !settings.chDot);
  }

  setSpread(px) {
    px = Math.min(px, 60);
    if (Math.abs(px - this._spreadPx) < 0.4) return;
    this._spreadPx = px;
    this.crosshair.style.setProperty("--ch-gap", settings.chGap + px + "px");
  }

  show() {
    this.root.hidden = false;
    this.fpsBadge.hidden = !settings.showFps;
  }
  hide() {
    this.root.hidden = true;
    this.scope.hidden = true;
    this.vLow.classList.remove("on");
    this.vHurt.style.opacity = 0;
  }

  setRound(n, total) {
    this.elRound.textContent = n;
    this.elRound.nextElementSibling.textContent = "/" + total;
  }
  setEnemies(n) {
    this.elEnemies.textContent = n;
  }
  setTimer(sec) {
    this.elTimer.textContent = formatTime(sec);
  }

  setHealth(hp, shield) {
    this.elHp.textContent = Math.max(0, Math.ceil(hp));
    this.elHp.classList.toggle("hurt", hp < 35);
    this.barHp.style.width = Math.max(0, hp) + "%";
    this.barHp.className = hp < 35 ? "low" : hp < 65 ? "mid" : "";
    this.barHp.id = "bar-hp";
    this.barShield.style.width = Math.max(0, (shield / 50) * 100) + "%";
    this.vLow.classList.toggle("on", hp > 0 && hp < 35);
  }

  hurtFlash(strength = 1) {
    this._hurtT = Math.min(0.5, this._hurtT + 0.22 * strength);
  }

  damageArc(angleDeg) {
    const el = this.arcPool[this._arcIdx];
    this._arcIdx = (this._arcIdx + 1) % this.arcPool.length;
    el.style.display = "none";
    // force restart animation
    void el.offsetWidth;
    el.style.setProperty("--rot", angleDeg + "deg");
    el.style.display = "block";
  }

  setAmmo(mag, reserve) {
    this.elMag.textContent = mag;
    this.elMag.classList.toggle("empty", mag === 0);
    this.elReserve.textContent = "/ " + reserve;
  }

  setWeaponRail(state) {
    this.elWeapon.textContent = state.name;
    let html = "";
    for (const s of state.slots) {
      html += `<div class="wslot${s.active ? " active" : ""}${s.mag + s.reserve === 0 ? " dry" : ""}"><b>${s.slot}</b>${s.name}</div>`;
    }
    this.rail.innerHTML = html;
  }

  hitmark(kill, headshot) {
    const hm = this.hitmarker;
    hm.classList.remove("ping", "kill");
    void hm.offsetWidth;
    if (kill || headshot) hm.classList.add("kill");
    hm.classList.add("ping");
  }

  damageNumber(wx, wy, wz, amount, headshot, camera) {
    if (!settings.dmgNumbers) return;
    const d = this.dmgPool[this._dmgIdx];
    this._dmgIdx = (this._dmgIdx + 1) % this.dmgPool.length;
    d.active = true;
    d.wx = wx + (Math.random() - 0.5) * 0.3;
    d.wy = wy + 0.2;
    d.wz = wz + (Math.random() - 0.5) * 0.3;
    d.t = 0.75;
    d.el.textContent = amount;
    d.el.className = "dmg-num" + (headshot ? " hs" : "");
    d.el.style.display = "block";
  }

  killfeedPush(text, accentWord) {
    const row = document.createElement("div");
    row.className = "kf-row";
    row.innerHTML = accentWord ? `${text} <span class="kf-hs">${accentWord}</span>` : text;
    this.killfeed.prepend(row);
    while (this.killfeed.children.length > 5) this.killfeed.lastChild.remove();
    setTimeout(() => {
      row.classList.add("fading");
      setTimeout(() => row.remove(), 450);
    }, 3400);
  }

  announce(main, sub = "", { accent = false, hold = 1.6 } = {}) {
    const token = ++this._announceToken;
    this.announcer.hidden = false;
    this.announcer.classList.remove("out");
    this.announceMain.textContent = main;
    this.announceMain.classList.toggle("accent", accent);
    this.announceSub.textContent = sub;
    // restart pop animation
    this.announceMain.style.animation = "none";
    this.announceSub.style.animation = "none";
    void this.announceMain.offsetWidth;
    this.announceMain.style.animation = "";
    this.announceSub.style.animation = "";
    setTimeout(() => {
      if (token !== this._announceToken) return;
      this.announcer.classList.add("out");
      setTimeout(() => {
        if (token === this._announceToken) this.announcer.hidden = true;
      }, 320);
    }, hold * 1000);
  }

  setScope(on) {
    this.scope.hidden = !on;
    this.crosshair.style.visibility = on ? "hidden" : "visible";
  }

  setAiming(hideCrosshairDot) {
    // reserved for future per-weapon crosshair behavior
  }

  pickupToast(text) {
    const t = this.toast;
    t.hidden = false;
    t.textContent = text;
    t.style.animation = "none";
    void t.offsetWidth;
    t.style.animation = "";
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => (t.hidden = true), 1400);
  }

  setScoreboard(visible, statsHtml) {
    this.scoreboardEl.hidden = !visible;
    if (visible && statsHtml) this.liveStats.innerHTML = statsHtml;
  }

  setFps(v) {
    if (!this.fpsBadge.hidden) this.fpsBadge.textContent = v;
  }

  // ---- SUNBURST ultimate ----
  setUlt(frac) {
    const meter = $("ult-meter");
    const ring = $("ult-ring");
    const CIRC = 169.6;
    ring.style.strokeDashoffset = CIRC * (1 - Math.max(0, Math.min(1, frac)));
    meter.classList.toggle("ready", frac >= 1);
  }

  ultDenied() {
    const meter = $("ult-meter");
    meter.classList.remove("denied");
    void meter.offsetWidth;
    meter.classList.add("denied");
  }

  setFlash(v) {
    if (v !== this._lastFlash) {
      this._lastFlash = v;
      $("screen-flash").style.opacity = Math.min(1, v) * 0.9;
    }
  }

  update(dt, camera) {
    // hurt vignette decay
    if (this._hurtT > 0) {
      this._hurtT = Math.max(0, this._hurtT - dt);
      this.vHurt.style.opacity = Math.min(1, this._hurtT * 4);
    }

    // project damage numbers
    const w = window.innerWidth, h = window.innerHeight;
    for (const d of this.dmgPool) {
      if (!d.active) continue;
      d.t -= dt;
      if (d.t <= 0) {
        d.active = false;
        d.el.style.display = "none";
        continue;
      }
      _v.set(d.wx, d.wy + (0.75 - d.t) * 0.9, d.wz).project(camera);
      if (_v.z > 1 || _v.z < -1) {
        d.el.style.display = "none";
        continue;
      }
      d.el.style.display = "block";
      d.el.style.left = ((_v.x + 1) / 2) * w + "px";
      d.el.style.top = ((1 - _v.y) / 2) * h + "px";
      d.el.style.opacity = Math.min(1, d.t * 3);
    }
  }

  reset() {
    this.killfeed.innerHTML = "";
    this.announcer.hidden = true;
    this._announceToken++;
    for (const d of this.dmgPool) {
      d.active = false;
      d.el.style.display = "none";
    }
    this.setScoreboard(false);
    this.vHurt.style.opacity = 0;
    this.vLow.classList.remove("on");
    this.setScope(false);
    this.setSpread(0);
    this.setUlt(0);
    this.setFlash(0);
  }
}
