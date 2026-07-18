// Multiplayer smoke test: starts the game server (serving dist/), drives two
// headless clients through create/join, snapshots, authoritative kills,
// respawn, match over, auto-restart and leave. Fails on any console/page
// error on either client. Usage: node scripts/mpsmoke.mjs [outDir]
// Run npm run build first.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || path.join(root, "qa-shots-mp");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const PORT = 8093;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- game server (short match: first to 2, restart after 3s) ----
const srv = spawn(process.execPath, [path.join(root, "server", "index.js")], {
  env: { ...process.env, PORT: String(PORT), KILL_TARGET: "2", RESTART_S: "3", RESPAWN_S: "2" },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stderr.on("data", (d) => errors.push("SERVER STDERR: " + d.toString().slice(0, 300)));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server did not start")), 8000);
  srv.stdout.on("data", (d) => {
    if (d.toString().includes("SOLSTRIKE server")) {
      clearTimeout(t);
      resolve();
    }
  });
});
console.log("game server on :" + PORT);

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--enable-unsafe-swiftshader",
  "--window-size=1280,720",
  "--mute-audio",
  // both clients must keep simulating even when not the focused page
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
const browsers = [];

async function makeClient(tag) {
  console.log("launching client", tag);
  const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS, protocolTimeout: 120000 });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() !== "error") return;
    if (/GPU stall|swiftshader|WebGL.*fallback|Automatic fallback/i.test(text)) return;
    errors.push(tag + " CONSOLE: " + text.slice(0, 300));
  });
  page.on("pageerror", (err) => errors.push(tag + " PAGEERROR: " + err.message.slice(0, 300)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => !!window.__SOL, { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.clear(); // no sol-server leakage between runs
    window.__SOL.input.simulate = true;
  });
  console.log("client", tag, "ready");
  return page;
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(outDir, name + ".png") });
  console.log("  shot:", name);
};

const A = await makeClient("A");
const B = await makeClient("B");

try {
  // ---- menu UI sanity: multiplayer screen opens ----
  await A.click("#btn-mp");
  await sleep(400);
  await shot(A, "01-mp-screen");

  // ---- host creates, guest joins ----
  await A.evaluate(() => window.__SOL.mpCreate("ALPHA", "bazaar"));
  await A.waitForFunction(() => window.__SOL.session?.mp && window.__SOL.session.roomCode, { timeout: 15000 });
  const code = await A.evaluate(() => window.__SOL.session.roomCode);
  const aId = await A.evaluate(() => window.__SOL.net.id);
  console.log("room:", code, "hostId:", aId);

  await B.evaluate((c) => window.__SOL.mpJoin("BRAVO", c), code);
  await B.waitForFunction(() => window.__SOL.session?.mp, { timeout: 15000 });
  const bId = await B.evaluate(() => window.__SOL.net.id);

  // both must agree on seed (same arena) and see one remote each
  await A.waitForFunction(() => window.__SOL.session.remotes.map.size === 1, { timeout: 5000 });
  const seedA = await A.evaluate(() => window.__SOL.session.opts.seed);
  const seedB = await B.evaluate(() => window.__SOL.session.opts.seed);
  if (seedA !== seedB) errors.push("SEED MISMATCH: " + seedA + " vs " + seedB);
  const remotesB = await B.evaluate(() => window.__SOL.session.remotes.map.size);
  if (remotesB !== 1) errors.push("B remote count " + remotesB);
  console.log("both joined, shared seed:", seedA);

  // ---- snapshots flow: A moves, B's remote avatar must track it ----
  await A.bringToFront();
  await A.keyboard.down("KeyW");
  await sleep(1400);
  await A.keyboard.up("KeyW");
  await sleep(500);
  const aPos = await A.evaluate(() => ({ x: window.__SOL.session.player.x, z: window.__SOL.session.player.z }));
  const seenByB = await B.evaluate((id) => {
    const r = window.__SOL.session.remotes.get(id);
    return r ? { x: r.x, z: r.z, buf: r.buf.length, visible: r.group.visible } : null;
  }, aId);
  if (!seenByB || seenByB.buf < 3) errors.push("B receives no snapshots for A: " + JSON.stringify(seenByB));
  else {
    const drift = Math.hypot(aPos.x - seenByB.x, aPos.z - seenByB.z);
    console.log("A pos vs B's view of A, drift:", drift.toFixed(2), "m, visible:", seenByB.visible);
    if (drift > 3) errors.push("REMOTE POSITION DRIFT " + drift.toFixed(2) + "m");
    if (!seenByB.visible) errors.push("REMOTE AVATAR NOT VISIBLE ON B");
  }
  await shot(A, "02-A-view");
  await shot(B, "03-B-sees-A");

  // ---- remote fire + ult visuals reach the other client ----
  await A.evaluate(() => {
    const s = window.__SOL.session;
    window.__SOL.net.send({ t: "fire", w: "havoc", d: [s.player.x, 1.6, s.player.z, 0, 0, -1] });
    window.__SOL.net.send({ t: "ult", x: s.player.x, z: s.player.z });
  });
  await sleep(1300);
  const ultSeen = await B.evaluate(() => window.__SOL.session.sunburst.active);
  if (!ultSeen) errors.push("B did not see A's sunburst");
  await shot(B, "04-B-sees-ult");

  // ---- authoritative kill: A reports hits on B until B dies ----
  const killB = async () => {
    await A.evaluate((id) => {
      for (let i = 0; i < 3; i++) window.__SOL.net.send({ t: "hit", target: id, dmg: 60, part: "body", w: "havoc" });
    }, bId);
    await B.waitForFunction(() => window.__SOL.session.state === "dead" || window.__SOL.session.state === "over", { timeout: 5000 });
  };
  await killB();
  console.log("kill 1 confirmed on B");
  await shot(B, "05-B-eliminated");
  const aKills = await A.evaluate(() => window.__SOL.session.stats.kills);
  if (aKills !== 1) errors.push("A kill count after kill1: " + aKills);

  // B respawns with full hp + spawn protection
  await B.waitForFunction(() => window.__SOL.session.state === "playing", { timeout: 8000 });
  const bHp = await B.evaluate(() => ({ hp: window.__SOL.session.hp, shield: window.__SOL.session.shield }));
  if (bHp.hp !== 100 || bHp.shield !== 50) errors.push("B respawn hp wrong: " + JSON.stringify(bHp));
  console.log("B respawned:", JSON.stringify(bHp));

  // scoreboard overlay on A
  await A.bringToFront();
  await A.keyboard.down("Tab");
  await sleep(350);
  await shot(A, "06-A-scoreboard");
  await A.keyboard.up("Tab");

  // ---- second kill ends the match (KILL_TARGET=2) ----
  await sleep(2300); // spawn protection must lapse
  await killB();
  await A.waitForFunction(() => window.__SOL.session.state === "over", { timeout: 5000 });
  console.log("match over after kill 2");
  await sleep(2000); // onEnd fires at 1.6s → end screens
  // check before the screenshots: swiftshader shots are slow and the 3s
  // auto-restart legitimately hides the end screen again
  const endVisible = await B.evaluate(() => !document.getElementById("screen-end").hidden && !document.getElementById("end-mp-board").hidden);
  if (!endVisible) errors.push("B end screen / MP board not visible");
  await shot(A, "07-A-victory-end");
  await shot(B, "08-B-defeat-end");

  // ---- auto-restart: server restarts room, both clients get a new match ----
  await A.waitForFunction(() => window.__SOL.session?.mp && window.__SOL.session.state === "playing" && window.__SOL.session.stats.kills === 0, { timeout: 12000 });
  await B.waitForFunction(() => window.__SOL.session?.mp && window.__SOL.session.state === "playing", { timeout: 12000 });
  const seedA2 = await A.evaluate(() => window.__SOL.session.opts.seed);
  const seedB2 = await B.evaluate(() => window.__SOL.session.opts.seed);
  if (seedA2 !== seedB2) errors.push("RESTART SEED MISMATCH");
  if (seedA2 === seedA) errors.push("RESTART DID NOT RESEED");
  console.log("auto-restart OK, new seed:", seedA2);
  await sleep(700);
  await shot(A, "09-A-rematch");

  // ---- leave: B closes, A must see the remote go away ----
  await browsers[1].close();
  await A.waitForFunction(() => window.__SOL.session.remotes.map.size === 0, { timeout: 8000 });
  console.log("A saw B leave");
  await shot(A, "10-A-alone");

  // ---- quit: A back to menu, room dies server-side ----
  await A.evaluate(() => window.__SOL.quitToMenu());
  await sleep(1000);
  await shot(A, "11-A-menu");
  const netGone = await A.evaluate(() => window.__SOL.net === null);
  if (!netGone) errors.push("A net not closed after quit");
} catch (err) {
  errors.push("SCRIPT: " + err.message);
}

for (const b of browsers) await b.close().catch(() => {});
srv.kill();

console.log("\n=== errors:", errors.length, "===");
for (const e of errors) console.log("  ERROR:", e.slice(0, 400));
console.log(errors.length ? "\nMPSMOKE: FAIL" : "\nMPSMOKE: PASS");
process.exit(errors.length ? 1 : 0);
