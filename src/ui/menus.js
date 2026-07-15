// Menu screens: navigation, settings bindings (live-applied + persisted),
// map/difficulty selection, end-of-match screen. All light theme, DOM only.

import { settings, setSetting } from "../core/settings.js";
import { audio } from "../core/audio.js";
import { formatTime } from "../core/utils.js";

const $ = (id) => document.getElementById(id);

const SCREENS = ["menu", "setup", "howto", "settings", "pause", "end"];

export class Menus {
  constructor(cbs) {
    this.cbs = cbs;
    this.current = null;
    this._settingsFrom = "menu";
    this.els = {};
    for (const s of SCREENS) this.els[s] = $("screen-" + s);

    this._bindNav();
    this._bindSettings();
    this._bindSelections();
    this._bindSounds();
  }

  show(name) {
    for (const s of SCREENS) {
      const el = this.els[s];
      if (s === name) {
        el.hidden = false;
        requestAnimationFrame(() => el.classList.add("visible"));
      } else {
        el.classList.remove("visible");
        el.hidden = true;
      }
    }
    this.current = name;
  }

  hideAll() {
    this.show(null);
  }

  busy(text) {
    const b = $("busy");
    if (text) {
      $("busy-text").textContent = text;
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }

  _bindNav() {
    $("btn-play").addEventListener("click", () => this.show("setup"));
    $("btn-howto").addEventListener("click", () => this.show("howto"));
    $("btn-howto-back").addEventListener("click", () => this.show("menu"));
    $("btn-settings").addEventListener("click", () => {
      this._settingsFrom = "menu";
      this.show("settings");
    });
    $("btn-pause-settings").addEventListener("click", () => {
      this._settingsFrom = "pause";
      this.show("settings");
    });
    $("btn-settings-back").addEventListener("click", () => this.show(this._settingsFrom));
    $("btn-setup-back").addEventListener("click", () => this.show("menu"));
    $("btn-start-match").addEventListener("click", () => this.cbs.onStart(settings.map, settings.difficulty));
    $("btn-resume").addEventListener("click", () => this.cbs.onResume());
    $("btn-quit").addEventListener("click", () => this.cbs.onQuit());
    $("btn-rematch").addEventListener("click", () => this.cbs.onRematch());
    $("btn-menu-return").addEventListener("click", () => this.cbs.onQuit());
  }

  setPauseProgress(text) {
    $("pause-progress").textContent = text;
  }

  showEnd(result) {
    const s = result.stats;
    $("end-kicker").textContent = result.victory
      ? result.map + " · MISSION COMPLETE"
      : result.map + " · REACHED ROUND " + result.round;
    const title = $("end-title");
    title.textContent = result.victory ? "VICTORY" : "DEFEAT";
    title.classList.toggle("defeat", !result.victory);
    const badge = $("rank-badge");
    badge.hidden = !result.rank;
    if (result.rank) $("rank-letter").textContent = result.rank;

    const acc = s.shots > 0 ? Math.round((s.hits / s.shots) * 100) : 0;
    const cells = [
      [s.score, "SCORE"],
      [s.kills, "KILLS"],
      [s.headshots, "HEADSHOTS"],
      [acc + "%", "ACCURACY"],
      [s.bestStreak + "x", "BEST STREAK"],
      [formatTime(result.time), "TIME"],
    ];
    $("end-stats").innerHTML = cells
      .map(([v, l]) => `<div class="stat-cell"><b>${v}</b><span>${l}</span></div>`)
      .join("");
    this.show("end");
  }

  // ------------------------------------------------------------- settings

  _bindSettings() {
    const bindRange = (id, key, labelId, fmt = (v) => v) => {
      const el = $(id);
      const label = $(labelId);
      el.value = settings[key];
      label.textContent = fmt(settings[key]);
      el.addEventListener("input", () => {
        const v = parseFloat(el.value);
        setSetting(key, v);
        label.textContent = fmt(v);
      });
    };
    bindRange("set-sens", "sens", "val-sens", (v) => Number(v).toFixed(2));
    bindRange("set-adssens", "adsSens", "val-adssens", (v) => Number(v).toFixed(2));
    bindRange("set-fov", "fov", "val-fov");
    bindRange("set-master", "master", "val-master");
    bindRange("set-sfx", "sfx", "val-sfx");
    bindRange("set-music", "music", "val-music");
    bindRange("set-chsize", "chSize", "val-chsize");
    bindRange("set-chgap", "chGap", "val-chgap");

    const bindToggle = (id, key) => {
      const el = $(id);
      el.checked = settings[key];
      el.addEventListener("change", () => setSetting(key, el.checked));
    };
    bindToggle("set-bob", "bob");
    bindToggle("set-dmgnum", "dmgNumbers");
    bindToggle("set-fps", "showFps");
    bindToggle("set-chdot", "chDot");
    bindToggle("set-cv", "handsFree");
    bindRange("set-headsens", "headSens", "val-headsens", (v) => Number(v).toFixed(2));

    // quality segmented
    const seg = $("quality-seg");
    const applySeg = () => {
      for (const b of seg.children) b.classList.toggle("selected", b.dataset.q === settings.quality);
    };
    applySeg();
    seg.addEventListener("click", (e) => {
      const q = e.target.dataset?.q;
      if (!q) return;
      setSetting("quality", q);
      applySeg();
    });

    // crosshair swatches + preview
    const sw = $("crosshair-swatches");
    const applySwatch = () => {
      for (const b of sw.children) b.classList.toggle("selected", b.dataset.c === settings.chColor);
    };
    applySwatch();
    sw.addEventListener("click", (e) => {
      const c = e.target.dataset?.c;
      if (!c) return;
      setSetting("chColor", c);
      applySwatch();
      this._applyPreview();
    });

    for (const id of ["set-chsize", "set-chgap", "set-chdot"]) {
      $(id).addEventListener("input", () => this._applyPreview());
    }
    this._applyPreview();
  }

  _applyPreview() {
    const p = $("crosshair-preview");
    p.style.setProperty("--ch-color", settings.chColor);
    p.style.setProperty("--ch-size", settings.chSize + "px");
    p.style.setProperty("--ch-gap", settings.chGap + "px");
    p.classList.toggle("no-dot", !settings.chDot);
  }

  // ------------------------------------------------------------ selections

  _bindSelections() {
    const cards = document.querySelectorAll(".map-card");
    const applyMap = () => {
      for (const c of cards) c.classList.toggle("selected", c.dataset.map === settings.map);
    };
    applyMap();
    for (const c of cards) {
      c.addEventListener("click", () => {
        setSetting("map", c.dataset.map);
        applyMap();
      });
    }

    const seg = $("difficulty-seg");
    const applyDiff = () => {
      for (const b of seg.children) b.classList.toggle("selected", b.dataset.diff === settings.difficulty);
    };
    applyDiff();
    seg.addEventListener("click", (e) => {
      const d = e.target.dataset?.diff;
      if (!d) return;
      setSetting("difficulty", d);
      applyDiff();
    });
  }

  _bindSounds() {
    document.addEventListener("click", (e) => {
      if (e.target.closest(".btn, .map-card, .seg-item, .swatch, input")) {
        audio.ensure();
        audio.uiClick();
      }
    });
    document.addEventListener(
      "mouseover",
      (e) => {
        if (e.target.closest?.(".btn, .map-card")) audio.uiHover();
      },
      { passive: true }
    );
  }
}
