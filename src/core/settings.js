// Persistent player settings. Single source of truth, saved to localStorage,
// with change listeners so live systems (camera FOV, audio buses, crosshair
// CSS vars) react immediately.

const KEY = "solstrike-settings-v1";

const DEFAULTS = {
  sens: 1.0,
  adsSens: 0.8,
  fov: 95,
  bob: true,
  dmgNumbers: true,
  quality: "auto", // auto | high | medium | low
  showFps: false,
  master: 80,
  sfx: 100,
  music: 55,
  chColor: "#2dd4bf",
  chSize: 7,
  chGap: 3,
  chDot: true,
  difficulty: "standard",
  map: "random",
  handsFree: false,
  headSens: 1.0,
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = load();

const listeners = new Set();

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage may be unavailable; play session still works */
  }
  for (const fn of listeners) fn(key, value);
}
