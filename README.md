# SOLSTRIKE

A fast, crisp arena FPS that runs entirely in the browser. Clear 13 escalating
rounds against the Spectre robot squad across three sunlit arenas. No downloads,
no assets to fetch — every model, map and sound is generated procedurally at
runtime, so the whole game is ~160 KB gzipped and loads instantly.

## Play (development)

```bash
npm install
npm run dev        # http://localhost:5173
```

## Build & deploy

```bash
npm run build      # outputs static site to dist/
npm run preview    # serve the production build locally
```

`dist/` is a fully static site with relative paths (`base: "./"`), so it works on
any static host with zero configuration:

- **Netlify** — drag & drop the `dist` folder onto app.netlify.com/drop
- **GitHub Pages** — push `dist` contents to a `gh-pages` branch (or any repo + Pages)
- **Vercel** — `vercel deploy dist`
- **itch.io** — zip the contents of `dist` and upload as an HTML game

## Controls

| Input | Action |
| --- | --- |
| WASD | Move |
| Mouse | Aim · LMB fire · RMB aim-down-sights / scope |
| Shift | Walk (silent + accurate) |
| Ctrl / C | Crouch |
| Space | Jump |
| R | Reload |
| 1–5 / wheel / V | Switch weapon · Q last weapon |
| X | ☀ SUNBURST ultimate (fills from kills) |
| Tab (hold) | Match stats |
| Esc | Pause |

### Hands-free mode (webcam)

Settings → **HANDS-FREE (WEBCAM)** toggles head & face control (MediaPipe
FaceLandmarker, lazy-loaded from CDN on first enable). Sit centered, hold
still for a second to calibrate, then: turn your head to look around, lean
left/right to strafe, lean toward/away from the screen to move, open your
mouth to fire, raise your eyebrows to reload, **smile to switch weapon**,
and **pucker (blow a kiss) to fire the SUNBURST ultimate**. Press **N** any
time to recenter the neutral pose. Keyboard and mouse stay active alongside
it.

**Weapons:** HAVOC auto rifle · MAULER pump shotgun · LONGBOW bolt sniper
(RMB scope) · OGRE rocket launcher (splash + rocket-jump knockback) · VESPA
sidearm.

**Tips:** first shots while standing/walking are laser accurate — stop, then
shoot. Headshots deal heavy bonus damage. Medkits and ammo crates respawn
around the arena. Fast, accurate round clears raise your end-of-match rank
(C → S).

## Maps

- **BAZAAR** — sunlit market lanes, tight corners
- **FROSTHOLD** — bright snow port, long sightlines
- **MESA** — red canyon town, climbable watchtower

Every match uses a random seed: prop layout, sun angle and sky shift each time
(pick RANDOM for a surprise theme).

## Tech notes

- Three.js, no physics engine — custom AABB collide-and-slide movement tuned
  for counter-strafe stops, plus slab raycasts for ballistics and AI sight.
- Whole static arena is merged into ~2 draw calls (vertex-colored geometry);
  effects (tracers, sparks, smoke, debris, decals, bot shatter) are pooled
  instanced meshes with zero per-frame allocation.
- Bots are hierarchical low-poly rigs (no skinning) driven by A* over a nav
  grid, with strafing combat, telegraphed bursts and accuracy that respects
  your movement.
- All audio is synthesized in WebAudio at play time (gunshots, footsteps,
  music sequencer, stingers) — the game works fully offline.
- Auto quality scaling: pixel ratio + shadow tier drop automatically if the
  frame rate dips (Settings → Quality to override).
- Hands-free control is an optional layer (`src/core/vision.js`): webcam →
  FaceLandmarker head pose + blendshapes → one-euro-filtered, deadzoned rate
  control injected into the same input state keyboard/mouse write to. The
  MediaPipe chunk (~40 KB gz + CDN wasm/model) loads only when enabled, so
  the base game stays small and offline-capable.

## Automated smoke test

```bash
npm run build
npm run smoke      # headless Chrome: drives a match, screenshots, fails on console errors
```

Screenshots land in `qa-shots/` (or pass a custom directory as an argument).

---

The previous hand-tracking prototype this project grew out of is archived in
`_legacy/`.
