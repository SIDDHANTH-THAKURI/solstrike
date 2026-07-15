// Automated smoke test: serves dist/, drives the game headless (simulated
// pointer lock), captures screenshots at key moments and fails on any
// console/page error. Usage: node scripts/smoke.mjs [outDir]

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const outDir = process.argv[2] || path.join(root, "qa-shots");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  try {
    const data = await readFile(path.join(dist, p));
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
console.log("serving dist on :" + port);

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--window-size=1600,900",
    "--mute-audio",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

const errors = [];
const warnings = [];
page.on("console", (msg) => {
  const t = msg.type();
  const text = msg.text();
  if (t === "error") {
    // swiftshader spam / benign GPU fallback messages are not game bugs
    if (/GPU stall|swiftshader|WebGL.*fallback|Automatic fallback/i.test(text)) return;
    errors.push(text);
  } else if (t === "warning") warnings.push(text);
});
page.on("pageerror", (err) => errors.push("PAGEERROR: " + err.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  await page.screenshot({ path: path.join(outDir, name + ".png") });
  console.log("  shot:", name);
};

try {
  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(1600);
  await shot("01-menu");

  // enable simulated pointer lock for headless
  await page.evaluate(() => {
    window.__SOL.input.simulate = true;
  });

  // ---- match on bazaar ----
  await page.evaluate(() => window.__SOL.startMatch("bazaar", "standard"));
  await sleep(600);
  // god mode for the scripted phase: the camera poses stand still for long
  // stretches and bots will happily kill the test player otherwise
  await page.evaluate(() => {
    window.__SOL.session._damagePlayer = () => {};
  });
  await sleep(2000);
  await shot("02-round1-bazaar");

  // look around + move
  await page.evaluate(() => window.__SOL.input.simLook(-160, 20));
  await page.keyboard.down("KeyW");
  await sleep(900);
  await page.keyboard.up("KeyW");
  await shot("03-moved");

  // fire rifle burst
  await page.evaluate(() => window.__SOL.input.simMouse(0, true));
  await sleep(450);
  await shot("04-rifle-firing");
  await page.evaluate(() => window.__SOL.input.simMouse(0, false));
  await sleep(400);

  // weapon switches
  for (const [key, name] of [["2", "05-shotgun"], ["3", "06-sniper"], ["5", "07-pistol"]]) {
    await page.keyboard.press("Digit" + key);
    await sleep(750);
    await shot(name);
  }

  // sniper scope check
  await page.keyboard.press("Digit3");
  await sleep(750);
  await page.evaluate(() => window.__SOL.input.simMouse(2, true));
  await sleep(500);
  await shot("08-scoped");
  await page.evaluate(() => window.__SOL.input.simMouse(2, false));
  await sleep(300);

  // rocket + explosion (fire toward a far wall, catch mid-flight + boom)
  await page.keyboard.press("Digit4");
  await sleep(800);
  await page.evaluate(() => window.__SOL.input.simLook(0, 120)); // slight down
  await page.evaluate(() => window.__SOL.input.simMouse(0, true));
  await sleep(90);
  await page.evaluate(() => window.__SOL.input.simMouse(0, false));
  await sleep(300);
  await shot("09a-rocket-flight");
  // wait for impact then catch the fireball early
  await page.waitForFunction(
    () => !window.__SOL.session.combat.rockets.some((r) => r.active),
    { timeout: 8000 }
  );
  await sleep(120);
  await shot("09b-explosion");
  await page.evaluate(() => window.__SOL.input.simLook(0, -120));

  // reload anim
  await page.keyboard.press("Digit1");
  await sleep(600);
  await page.keyboard.press("KeyR");
  await sleep(500);
  await shot("10-reload");
  await sleep(1800);

  // force a kill for killfeed/shatter
  await page.evaluate(() => {
    const s = window.__SOL.session;
    const b = s.bots.bots.find((b) => b.alive && b.state !== "spawning");
    if (b) s.combat._killBot(b, "head", "shot");
  });
  await sleep(250);
  await shot("11-kill-shatter");

  // let bots close distance, then pose the camera at the nearest one
  await sleep(9000);
  const botInfo = await page.evaluate(() => {
    const s = window.__SOL.session;
    const p = s.player;
    let best = null, bd = 1e9;
    for (const b of s.bots.bots) {
      if (!b.alive) continue;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return null;
    // aim straight at the bot
    p.yaw = Math.atan2(-(best.x - p.x), -(best.z - p.z));
    p.pitch = -0.02;
    return { d: bd, state: best.state, x: best.x, z: best.z };
  });
  console.log("  nearest bot:", JSON.stringify(botInfo));
  await sleep(400);
  await shot("11b-bot-closeup");
  await sleep(1200);
  await shot("11c-bot-combat");

  // bots must have moved off their spawn pads (hunting works)
  const moved = await page.evaluate(() => {
    const s = window.__SOL.session;
    const spawns = s.map.botSpawns;
    let movedCount = 0;
    for (const b of s.bots.bots) {
      if (!b.alive) continue;
      let minD = 1e9;
      for (const [sx, sz] of spawns) minD = Math.min(minD, Math.hypot(b.x - sx, b.z - sz));
      if (minD > 3) movedCount++;
    }
    return movedCount;
  });
  console.log("  bots moved off spawn:", moved);
  if (botInfo && moved === 0) errors.push("BOTS NOT MOVING: all bots still at spawn after 12s");

  // every alive bot must be standing on walkable nav (no wall-spawns)
  const stuck = await page.evaluate(() => {
    const s = window.__SOL.session;
    const bad = [];
    for (const b of s.bots.bots) {
      if (!b.alive) continue;
      if (!s.map.nav.isOpenWorld(b.x, b.z)) bad.push([b.x.toFixed(1), b.z.toFixed(1)]);
    }
    return bad;
  });
  if (stuck.length) errors.push("BOTS IN WALLS: " + JSON.stringify(stuck));
  console.log("  bots inside walls:", stuck.length);

  // spawn points themselves must all be on open nav across all maps' data
  const badSpawns = await page.evaluate(() => {
    const s = window.__SOL.session;
    return s.map.botSpawns.filter(([x, z]) => !s.map.nav.isOpenWorld(x, z)).length;
  });
  if (badSpawns > 0) errors.push("SPAWN POINTS ON BLOCKED CELLS: " + badSpawns);
  console.log("  blocked spawn points:", badSpawns);

  // ---- SUNBURST ultimate ----
  const preUltState = await page.evaluate(() => window.__SOL.session.state);
  if (preUltState !== "playing") errors.push("SESSION NOT PLAYING BEFORE ULT TEST: " + preUltState);
  await page.evaluate(() => {
    const s = window.__SOL.session;
    s._gainUlt(1); // force full charge (also exercises ready announce + meter)
  });
  await sleep(400);
  await shot("11f-ult-ready");
  await page.evaluate(() => {
    window.__SOL.input.simLook(0, 60); // aim slightly down-range
    window.__SOL.input.pressVirtual("KeyX");
  });
  await sleep(500);
  await shot("11g-ult-telegraph");
  await sleep(600); // impact happens at 0.95s
  await shot("11h-ult-pillar");
  await sleep(600);
  await shot("11i-ult-fade");
  const ultState = await page.evaluate(() => {
    const s = window.__SOL.session;
    return { charge: s.ult, phase: s.sunburst.phase };
  });
  console.log("  ult after fire:", JSON.stringify(ultState));
  if (ultState.charge !== 0) errors.push("ULT DID NOT CONSUME CHARGE");
  await sleep(900);

  // clear the round → intermission → round 2 must start
  await page.evaluate(() => {
    const s = window.__SOL.session;
    s._spawnQueue.length = 0;
    s._pendingEnemies = 0;
    for (const b of s.bots.bots) if (b.alive) s.combat._killBot(b, "body", "shot");
  });
  await sleep(600);
  await shot("11d-round-clear");
  await sleep(5200);
  const roundNow = await page.evaluate(() => window.__SOL.session.round);
  console.log("  round after clear:", roundNow);
  if (roundNow !== 2) errors.push("ROUND PROGRESSION broke: still round " + roundNow);
  await shot("11e-round2");

  // scoreboard
  await page.keyboard.down("Tab");
  await sleep(300);
  await shot("12-scoreboard");
  await page.keyboard.up("Tab");

  // pause screen
  await page.evaluate(() => window.__SOL.input.releaseLock());
  await sleep(500);
  await shot("13-pause");
  await page.evaluate(() => window.__SOL.input.requestLock());
  await sleep(400);

  // ---- other maps ----
  for (const m of ["frosthold", "mesa"]) {
    await page.evaluate((mm) => window.__SOL.startMatch(mm, "standard"), m);
    await sleep(2800);
    await page.evaluate(() => window.__SOL.input.simLook(80, 10));
    await sleep(200);
    await shot("14-map-" + m);
  }

  // defeat flow → end screen
  await page.evaluate(() => {
    const s = window.__SOL.session;
    s._damagePlayer(500, s.player.x + 3, s.player.z + 3, false);
  });
  await sleep(2200);
  await shot("15-defeat");

  // back to menu
  await page.evaluate(() => window.__SOL.quitToMenu());
  await sleep(1200);
  await shot("16-menu-return");

  // simulated FPS report (swiftshader numbers are not real-world, but catch pathological slowness)
  const fps = await page.evaluate(() => window.__SOL.engine.fps);
  console.log("headless fps (swiftshader, not representative):", fps);
} catch (err) {
  errors.push("SCRIPT: " + err.message);
}

await browser.close();
server.close();

console.log("\n=== console warnings:", warnings.length, "===");
for (const w of warnings.slice(0, 8)) console.log("  warn:", w.slice(0, 200));
console.log("\n=== errors:", errors.length, "===");
for (const e of errors) console.log("  ERROR:", e.slice(0, 400));

if (errors.length > 0) {
  console.log("\nSMOKE: FAIL");
  process.exit(1);
} else {
  console.log("\nSMOKE: PASS");
  process.exit(0);
}
