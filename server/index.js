// SOLSTRIKE multiplayer server: room-based deathmatch relay with
// authoritative health/kills/respawns. Also serves the built client (dist/)
// so one process = one deployable game URL. Run: node server/index.js
// Env: PORT (default 8081).

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8081;
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TICK_MS = 50; // 20 Hz snapshots
const KILL_TARGET = +process.env.KILL_TARGET || 20; // env override for tests
const RESPAWN_S = +process.env.RESPAWN_S || 3;
const RESTART_S = +process.env.RESTART_S || 9;
const MAX_ROOM = 8;

// per-weapon max damage a single hit report may claim (headshot included)
const DMG_CAP = { havoc: 60, mauler: 130, longbow: 250, ogre: 130, vespa: 46, sunburst: 430 };

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".wasm": "application/wasm", ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(DIST, p);
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA-ish fallback to index for unknown paths
      fs.readFile(path.join(DIST, "index.html"), (e2, idx) => {
        if (e2) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("not found (run npm run build first)");
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

const rooms = new Map(); // code -> room
let nextId = 1;

function makeCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c = "";
  do {
    c = "";
    for (let i = 0; i < 5; i++) c += A[(Math.random() * A.length) | 0];
  } while (rooms.has(c));
  return c;
}

function makeRoom(map) {
  const room = {
    code: makeCode(),
    map: map || "random",
    seed: (Math.random() * 2 ** 31) | 0,
    players: new Map(), // id -> player
    state: "playing",
    restartAt: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function spawnPoint(room, forId) {
  // farthest of 8 random arena points from all enemies (map geometry is
  // client-side; clients snap to nearest open cell + ground themselves)
  let best = null, bestD = -1;
  for (let i = 0; i < 8; i++) {
    const x = (Math.random() * 2 - 1) * 24;
    const z = (Math.random() * 2 - 1) * 24;
    let d = Infinity;
    for (const p of room.players.values()) {
      if (p.id === forId || p.hp <= 0) continue;
      d = Math.min(d, (p.x - x) ** 2 + (p.z - z) ** 2);
    }
    if (d > bestD) {
      bestD = d;
      best = { x, z };
    }
  }
  // yaw faces the arena center (client forward is (-sin, -cos))
  return { x: best.x, z: best.z, yaw: Math.atan2(best.x, best.z) };
}

function broadcast(room, msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}

function roster(room) {
  const out = [];
  for (const p of room.players.values()) {
    out.push({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, hp: p.hp });
  }
  return out;
}

function leave(player) {
  const room = player.room;
  if (!room) return;
  room.players.delete(player.id);
  broadcast(room, { t: "leave", id: player.id, name: player.name });
  if (room.players.size === 0) rooms.delete(room.code);
}

function applyHit(room, shooter, msg) {
  if (room.state !== "playing" || shooter.hp <= 0) return;
  const target = room.players.get(msg.target);
  if (!target || target.hp <= 0) return;
  if (Date.now() < target.protectUntil) return;
  const cap = DMG_CAP[msg.w] || 60;
  const dmg = Math.max(1, Math.min(Math.round(msg.dmg), cap));

  // shield absorbs first, then hp
  let rem = dmg;
  const absorbed = Math.min(target.shield, rem);
  target.shield -= absorbed;
  rem -= absorbed;
  target.hp = Math.max(0, target.hp - rem);

  broadcast(room, {
    t: "hp", id: target.id, hp: target.hp, shield: target.shield,
    by: shooter.id, dmg, part: msg.part || "body",
    ax: shooter.x, az: shooter.z,
  });

  if (target.hp <= 0) {
    target.deaths++;
    if (shooter.id !== target.id) shooter.kills++; // no kill credit for suicide
    broadcast(room, {
      t: "die", id: target.id, by: shooter.id, part: msg.part || "body",
      w: msg.w, scores: roster(room),
    });
    if (shooter.kills >= KILL_TARGET) {
      room.state = "over";
      room.restartAt = Date.now() + RESTART_S * 1000;
      broadcast(room, { t: "over", winner: shooter.id, scores: roster(room), restartIn: RESTART_S });
    } else {
      setTimeout(() => {
        if (!room.players.has(target.id) || room.state !== "playing") return;
        const sp = spawnPoint(room, target.id);
        target.hp = 100;
        target.shield = 50;
        target.x = sp.x; target.z = sp.z;
        target.protectUntil = Date.now() + 2000;
        broadcast(room, { t: "spawn", id: target.id, x: sp.x, z: sp.z, yaw: sp.yaw });
      }, RESPAWN_S * 1000);
    }
  }
}

wss.on("connection", (ws) => {
  const player = {
    id: nextId++, ws, room: null, name: "OPERATOR",
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: 0, anim: 0, weapon: "havoc",
    hp: 100, shield: 50, kills: 0, deaths: 0,
    protectUntil: 0, lastMsg: Date.now(), stateDirty: false,
  };
  ws.on("pong", () => (player.lastMsg = Date.now()));

  ws.on("message", (raw) => {
    player.lastMsg = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const room = player.room;

    if (msg.t === "create" || msg.t === "join") {
      if (room) leave(player);
      let r;
      if (msg.t === "create") {
        r = makeRoom(typeof msg.map === "string" ? msg.map : "random");
      } else {
        r = rooms.get(String(msg.room || "").toUpperCase().trim());
        if (!r) return ws.send(JSON.stringify({ t: "err", m: "Room not found. Check the code." }));
        if (r.players.size >= MAX_ROOM) return ws.send(JSON.stringify({ t: "err", m: "Room is full (8 max)." }));
      }
      player.name = String(msg.name || "OPERATOR").slice(0, 14).toUpperCase() || "OPERATOR";
      player.room = r;
      player.kills = 0;
      player.deaths = 0;
      player.hp = 100;
      player.shield = 50;
      r.players.set(player.id, player);
      // hand out a spawn away from everyone already in the room — without
      // this every client would use the map's single default spawn point
      const sp = spawnPoint(r, player.id);
      player.x = sp.x;
      player.z = sp.z;
      player.yaw = sp.yaw;
      player.protectUntil = Date.now() + 2000;
      ws.send(JSON.stringify({
        t: "joined", id: player.id, room: r.code, map: r.map, seed: r.seed,
        scores: roster(r), spawn: sp,
      }));
      broadcast(r, { t: "join", id: player.id, name: player.name, scores: roster(r) }, player.id);
      return;
    }
    if (!room) return;

    if (msg.t === "s" && Array.isArray(msg.d) && msg.d.length >= 7) {
      const d = msg.d;
      player.x = +d[0] || 0; player.y = +d[1] || 0; player.z = +d[2] || 0;
      player.yaw = +d[3] || 0; player.pitch = +d[4] || 0;
      player.crouch = +d[5] || 0; player.anim = +d[6] || 0;
      if (typeof d[7] === "string") player.weapon = d[7];
      player.stateDirty = true;
    } else if (msg.t === "fire") {
      broadcast(room, { t: "fire", id: player.id, w: msg.w, d: msg.d }, player.id);
    } else if (msg.t === "ult") {
      broadcast(room, { t: "ult", id: player.id, x: +msg.x || 0, z: +msg.z || 0 }, player.id);
    } else if (msg.t === "hit") {
      applyHit(room, player, msg);
    }
  });

  ws.on("close", () => leave(player));
  ws.on("error", () => leave(player));
});

// 20 Hz snapshots + room housekeeping
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // match restart
    if (room.state === "over" && now >= room.restartAt) {
      room.state = "playing";
      room.seed = (Math.random() * 2 ** 31) | 0;
      const spawns = {};
      for (const p of room.players.values()) {
        p.kills = 0; p.deaths = 0; p.hp = 100; p.shield = 50;
        p.protectUntil = now + 2000;
        const sp = spawnPoint(room, p.id);
        p.x = sp.x;
        p.z = sp.z;
        p.yaw = sp.yaw;
        spawns[p.id] = sp;
      }
      broadcast(room, { t: "restart", seed: room.seed, map: room.map, scores: roster(room), spawns });
    }
    // snapshot: [id, x, y, z, yaw, pitch, crouch, anim, weapon, hp] per player
    const snap = [];
    for (const p of room.players.values()) {
      snap.push([p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +p.yaw.toFixed(3), +p.pitch.toFixed(3), +p.crouch.toFixed(2), p.anim, p.weapon, p.hp]);
    }
    if (snap.length > 0) broadcast(room, { t: "snap", time: now, p: snap });
  }
}, TICK_MS);

// heartbeat: ping every 10s, drop clients silent for 30s
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of [...room.players.values()]) {
      if (now - p.lastMsg > 30000) {
        p.ws.terminate();
        leave(p);
      } else if (p.ws.readyState === 1) {
        p.ws.ping();
      }
    }
  }
}, 10000);

server.listen(PORT, () => {
  console.log(`SOLSTRIKE server on http://localhost:${PORT} (ws same port)`);
});
