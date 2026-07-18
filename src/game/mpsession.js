// Multiplayer deathmatch session. Same feel/systems as the solo Session
// (prediction-free local movement, full weapon/effects stack) but opponents
// are live players streamed from the server: interpolated remote avatars,
// favor-the-shooter hit reports, server-authoritative health/kills/respawns.

import * as THREE from "three";
import { buildMap } from "../world/mapgen.js";
import { PlayerController } from "../player/controller.js";
import { CameraFeel } from "../player/camerafeel.js";
import { ViewModel } from "../weapons/viewmodel.js";
import { WeaponSystem } from "../weapons/weapons.js";
import { Effects } from "../effects/effects.js";
import { Sunburst } from "../effects/sunburst.js";
import { Combat } from "./combat.js";
import { RemoteManager } from "../net/net.js";
import { input } from "../core/input.js";
import { audio } from "../core/audio.js";
import { settings } from "../core/settings.js";
import { deepDispose } from "../core/engine.js";
import { clamp, formatTime } from "../core/utils.js";

const KILL_TARGET = 20;
const SEND_INTERVAL = 1 / 15;
const NO_INPUT = { moveForward: 0, moveRight: 0, walking: false, crouching: false, jumping: false };

const _camRight = new THREE.Vector3();
const _listenPos = new THREE.Vector3();
const _ultHit = {};

export class MpSession {
  constructor(engine, hud, opts) {
    this.engine = engine;
    this.hud = hud;
    this.opts = opts; // {net, map, seed, roomCode, scores, onEnd(result)}
    this.net = opts.net;
    this.mp = true;
    this.roomCode = opts.roomCode;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.06, 600);
    this.map = buildMap(this.scene, opts.map, opts.seed);
    engine.configureLight(this.map.lights.dir);

    this.player = new PlayerController(this.map.statics, this.map.half);
    this.player.reset(this.map.playerSpawn.x, this.map.playerSpawn.z, this.map.playerSpawn.yaw);
    this.camFeel = new CameraFeel(this.camera);

    this.effects = new Effects(this.scene);
    this.sunburst = new Sunburst(this.scene);
    this.remotes = new RemoteManager(this.scene, this.effects);
    this.vm = new ViewModel(this.camera, this.scene);
    this.vm.resize(window.innerWidth / window.innerHeight);
    this.weapons = new WeaponSystem(this.vm, this.camFeel, this.camera);
    this.combat = new Combat(this.map.statics, this.remotes, this.effects, this.player, this.camFeel);
    this.combat.initRockets(this.scene);
    this.weapons.combat = this.combat;

    this.state = "playing"; // playing | dead | over
    this.paused = false;
    this.hp = 100;
    this.shield = 50;
    this.timeElapsed = 0;
    this.round = 0; // main.js pause text reads this in solo; harmless here
    this.scores = opts.scores || [];
    this.stats = { kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0, damage: 0, bestStreak: 0, score: 0 };
    this._killChain = 0;
    this._killChainT = 0;
    this._shotHadHit = false;
    this._countedThisShot = false;
    this.ult = 0;
    this._ultReadyAnnounced = false;
    this._ultBlasting = false;
    this._rocketing = false;
    this._sendT = 0;
    this._protectT = 2;

    this._wireLocal();
    this._wireNet();

    // roster known at join time (includes players already in the room)
    for (const row of this.scores) {
      if (row.id !== this.net.id) this.remotes.add(row.id, row.name);
    }

    hud.reset();
    hud.show();
    this._roundPill = document.getElementById("pill-round");
    this._roundPillHtml = this._roundPill.innerHTML;
    this._roundPill.innerHTML = "ROOM <b>" + this.roomCode + "</b>";
    hud.setEnemies(this.remotes.aliveCount);
    hud.setHealth(this.hp, this.shield);
    hud.setWeaponRail(this.weapons.hudState());
    hud.setAmmo(25, 100);
    this.weapons.resetAll();
    audio.startMusic("combat");
    audio.setIntensity(0.35);
    hud.announce("DEATHMATCH", "FIRST TO " + KILL_TARGET + " · ROOM " + this.roomCode, { hold: 1.6 });
    audio.stinger("roundStart");
  }

  // --------------------------------------------------------------- wiring

  _wireLocal() {
    this.weapons.onAmmoChange = () => {
      const s = this.weapons.slotState;
      this.hud.setAmmo(s.mag, s.reserve);
      this.hud.setWeaponRail(this.weapons.hudState());
    };
    this.weapons.onWeaponChange = () => this.hud.setWeaponRail(this.weapons.hudState());
    this.weapons.onScopeChange = (on) => this.hud.setScope(on);

    // relay shots to the room + shot accounting
    const origHitscan = this.combat.fireHitscan.bind(this.combat);
    this.combat.fireHitscan = (o, d, def, m) => {
      if (!this._countedThisShot) {
        this._countedThisShot = true;
        this.stats.shots++;
        this._shotHadHit = false;
        queueMicrotask(() => (this._countedThisShot = false));
        this.net.send({ t: "fire", w: def.id, d: [r2(o.x), r2(o.y), r2(o.z), r3(d.x), r3(d.y), r3(d.z)] });
      }
      origHitscan(o, d, def, m);
    };
    const origRocket = this.combat.fireRocket.bind(this.combat);
    this.combat.fireRocket = (o, d, def) => {
      this.stats.shots++;
      this._shotHadHit = false;
      this.net.send({ t: "fire", w: def.id, d: [r2(o.x), r2(o.y), r2(o.z), r3(d.x), r3(d.y), r3(d.z)] });
      origRocket(o, d, def);
    };

    // local hit prediction → hitmark + report to server (authoritative)
    this.combat.onBotDamaged = (dmg, part, _killed, avatar, px, py, pz) => {
      this.stats.damage += dmg;
      this._gainUlt(dmg / 2600);
      if (!this._shotHadHit) {
        this._shotHadHit = true;
        this.stats.hits++;
      }
      this.hud.hitmark(false, part === "head");
      this.hud.damageNumber(px, py, pz, dmg, part === "head", this.camera);
      if (part === "head") audio.headshot();
      else audio.hitmark();
      const w = this._ultBlasting ? "sunburst" : this._rocketing ? "ogre" : this.weapons.def.id;
      this.net.send({ t: "hit", target: avatar.id, dmg, part, w });
    };
    this.combat.onBotKilled = () => {}; // server's die message is the source of truth
    this.combat.onPlayerDamaged = (dmg) => {
      // self splash (rocket jump): report to server so hp stays authoritative
      this.net.send({ t: "hit", target: this.net.id, dmg, part: "body", w: "ogre" });
    };

    this.player.onFootstep = (run) => audio.footstep(run, true);
    this.player.onLand = (fallSpeed) => {
      if (fallSpeed > 3) {
        audio.jumpLand(fallSpeed > 9);
        this.camFeel.landDip(clamp(fallSpeed / 9, 0.25, 1.4));
        this.vm.bump(clamp(fallSpeed / 12, 0.1, 0.8));
      }
    };

    this._unsubs = [
      input.onPress("KeyR", () => this._ifPlaying(() => this.weapons.tryReload())),
      input.onPress("KeyQ", () => this._ifPlaying(() => this.weapons.switchTo(this.weapons.last))),
      input.onPress("KeyX", () => this._ifPlaying(() => this._tryUlt())),
      input.onPress("KeyV", () => this._ifPlaying(() => this.weapons.cycle(1))),
      input.onPress("Digit1", () => this._ifPlaying(() => this.weapons.handleSlotKey(1))),
      input.onPress("Digit2", () => this._ifPlaying(() => this.weapons.handleSlotKey(2))),
      input.onPress("Digit3", () => this._ifPlaying(() => this.weapons.handleSlotKey(3))),
      input.onPress("Digit4", () => this._ifPlaying(() => this.weapons.handleSlotKey(4))),
      input.onPress("Digit5", () => this._ifPlaying(() => this.weapons.handleSlotKey(5))),
    ];
  }

  _wireNet() {
    const net = this.net;
    net.on("snap", (m) => this.remotes.applySnap(m, net.id));
    net.on("join", (m) => {
      this.remotes.add(m.id, m.name);
      this.scores = m.scores;
      this.hud.killfeedPush(m.name + " JOINED", "");
      this.hud.setEnemies(this.remotes.aliveCount);
    });
    net.on("leave", (m) => {
      this.remotes.remove(m.id);
      this.scores = this.scores.filter((r) => r.id !== m.id);
      this.hud.killfeedPush((m.name || "OPERATOR") + " LEFT", "");
      this.hud.setEnemies(this.remotes.aliveCount);
    });
    net.on("fire", (m) => this.remotes.remoteFire(m.id, m.w, m.d, this.map.statics));
    net.on("ult", (m) => {
      if (this.sunburst.active) return;
      audio.ultCharge();
      this.sunburst.fire(m.x, m.z, (bx, bz) => {
        _listenPos.set(bx, 1, bz);
        audio.ultBlast(_listenPos);
        // damage arrives via server hp messages; local knockback for feel
        const dx = this.player.x - bx, dz = this.player.z - bz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 9) {
          const k = 1 - d / 9;
          const il = 1 / (d || 1);
          this.player.impulse(dx * il * 10 * k, 6 * k + 2, dz * il * 10 * k);
          this.camFeel.addTrauma(0.8 * k);
        }
      });
    });
    net.on("hp", (m) => {
      if (m.id === net.id) {
        const prevShield = this.shield;
        this.hp = m.hp;
        this.shield = m.shield;
        this.hud.setHealth(this.hp, this.shield);
        if (m.by !== net.id) {
          this.hud.hurtFlash(clamp(m.dmg / 20, 0.4, 1));
          audio.hurt();
          if (prevShield > 0 && this.shield === 0) audio.shieldBreak();
          this.camFeel.addTrauma(0.16);
          const worldAng = Math.atan2(m.ax - this.player.x, m.az - this.player.z);
          const rel = worldAng - this.player.yaw + Math.PI;
          this.hud.damageArc((rel * 180) / Math.PI);
        }
      } else {
        const a = this.remotes.get(m.id);
        if (a) {
          a.hp = m.hp;
          if (m.by !== net.id) this.effects.shieldSpark(a.x, a.y + 1.2, a.z);
        }
      }
    });
    net.on("die", (m) => {
      this.scores = m.scores;
      const victim = this._name(m.id);
      const killer = this._name(m.by);
      if (m.id === net.id) {
        this.state = "dead";
        this.stats.deaths++;
        this._killChain = 0;
        this.hud.setHealth(0, 0);
        this.hud.hurtFlash(1);
        audio.stinger("defeat");
        this.hud.announce("ELIMINATED", "BY " + killer + " · REDEPLOY IN 3", { hold: 2.8 });
        this.hud.killfeedPush(killer + " ▸ YOU", m.part === "head" ? "HEADSHOT" : "");
      } else {
        const a = this.remotes.get(m.id);
        if (a && a.alive) a.kill(); // prediction may have hidden it already
        if (a) this.effects.shatter(a.x, 0.2, a.z, "#606c78", a.cfg.accent);
        if (m.by === net.id) {
          this.stats.kills++;
          if (m.part === "head" && m.w !== "ogre" && m.w !== "sunburst") this.stats.headshots++;
          audio.killConfirm();
          this._gainUlt(m.part === "head" ? 0.2 : 0.15);
          this._killChainT = 3.2;
          this._killChain++;
          this.stats.bestStreak = Math.max(this.stats.bestStreak, this._killChain);
          const chainNames = { 2: "DOUBLE KILL", 3: "TRIPLE KILL", 4: "QUAD KILL", 5: "RAMPAGE" };
          if (chainNames[this._killChain]) this.hud.announce(chainNames[this._killChain], "", { accent: true, hold: 0.9 });
          this.hud.killfeedPush("YOU ▸ " + victim, m.part === "head" ? "HEADSHOT" : m.w === "sunburst" ? "SUNBURST" : m.w === "ogre" ? "BOOM" : "");
          this.weapons.addAmmo();
          this.hud.pickupToast("+ AMMO RESTOCKED");
          const mine = this.scores.find((r) => r.id === net.id);
          if (mine && KILL_TARGET - mine.kills === 3) this.hud.announce("3 TO WIN", "", { accent: true, hold: 0.9 });
        } else {
          this.hud.killfeedPush(killer + " ▸ " + victim, "");
        }
      }
      this.hud.setEnemies(this.remotes.aliveCount);
    });
    net.on("spawn", (m) => {
      if (m.id === net.id) {
        const p = this._openSpot(m.x, m.z);
        this.player.reset(p.x, p.z, m.yaw);
        this.hp = 100;
        this.shield = 50;
        this._protectT = 2;
        this.hud.setHealth(this.hp, this.shield);
        this.weapons.resetAll();
        this.state = "playing";
        this.effects.spawnBeamFx(p.x, p.z);
        audio.stinger("roundStart");
        this.hud.announce("REDEPLOYED", "2s SPAWN PROTECTION", { hold: 1.1 });
      } else {
        const a = this.remotes.get(m.id);
        if (a) {
          a.respawn(m.x, m.z);
          this.effects.spawnBeamFx(m.x, m.z);
          _listenPos.set(m.x, 1, m.z);
          audio.spawnBeam(_listenPos);
        }
        this.hud.setEnemies(this.remotes.aliveCount);
      }
    });
    net.on("over", (m) => {
      if (this.state === "over") return;
      this.state = "over";
      this.scores = m.scores;
      const won = m.winner === this.net.id;
      audio.stopMusic();
      audio.stinger(won ? "victory" : "defeat");
      this.hud.announce(won ? "VICTORY" : this._name(m.winner) + " WINS", "NEXT MATCH STARTS SOON", { accent: won, hold: 1.6 });
      setTimeout(() => {
        input.releaseLock();
        this.opts.onEnd({
          mp: true,
          victory: won,
          winnerName: this._name(m.winner),
          roomCode: this.roomCode,
          scores: this.scores,
          myId: this.net.id,
          stats: { ...this.stats },
          time: this.timeElapsed,
        });
      }, 1600);
    });
  }

  _name(id) {
    if (id === this.net.id) return "YOU";
    const r = this.scores.find((s) => s.id === id);
    return r ? r.name : this.remotes.get(id)?.name || "OPERATOR";
  }

  // snap arbitrary server point to walkable ground near it
  _openSpot(x, z) {
    if (this.map.nav.isOpenWorld(x, z)) return { x, z };
    for (let r = 1; r <= 8; r++) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const nx = x + Math.cos(ang) * r;
        const nz = z + Math.sin(ang) * r;
        if (this.map.nav.isOpenWorld(nx, nz)) return { x: nx, z: nz };
      }
    }
    return this.map.playerSpawn;
  }

  _ifPlaying(fn) {
    if (!this.paused && this.state === "playing" && input.locked) fn();
  }

  _gainUlt(amount) {
    if (this.ult >= 1) return;
    this.ult = clamp(this.ult + amount, 0, 1);
    this.hud.setUlt(this.ult);
    if (this.ult >= 1 && !this._ultReadyAnnounced) {
      this._ultReadyAnnounced = true;
      audio.ultReady();
      this.hud.announce("SUNBURST READY", "PRESS X TO CALL THE SUN", { accent: true, hold: 1.5 });
    }
  }

  _tryUlt() {
    if (this.ult < 1 || this.sunburst.active) {
      audio.ultDenied();
      this.hud.ultDenied();
      return;
    }
    const cam = this.camera;
    cam.getWorldDirection(_camRight);
    const maxD = 42;
    let t = maxD;
    if (this.map.statics.raycast(cam.position.x, cam.position.y, cam.position.z, _camRight.x, _camRight.y, _camRight.z, maxD, _ultHit)) {
      t = _ultHit.t;
    }
    const lim = this.map.half - 2;
    const ix = clamp(cam.position.x + _camRight.x * t, -lim, lim);
    const iz = clamp(cam.position.z + _camRight.z * t, -lim, lim);
    this.ult = 0;
    this._ultReadyAnnounced = false;
    this.hud.setUlt(0);
    audio.ultCharge();
    this.net.send({ t: "ult", x: r2(ix), z: r2(iz) });
    this.sunburst.fire(ix, iz, (bx, bz) => {
      _listenPos.set(bx, 1, bz);
      audio.ultBlast(_listenPos);
      this._ultBlasting = true;
      this.combat.sunburstBlast(bx, bz);
      this._ultBlasting = false;
    });
  }

  // ---------------------------------------------------------------- frame

  setPaused(p) {
    // no sim freeze in multiplayer — the match continues server-side
    this.paused = p;
    this.hud.crosshair.style.visibility = p ? "hidden" : "visible";
  }

  update(dt) {
    this.timeElapsed += dt;
    this.hud.setTimer(this.timeElapsed);
    if (this._protectT > 0) this._protectT -= dt;
    if (this._killChainT > 0) {
      this._killChainT -= dt;
      if (this._killChainT <= 0) this._killChain = 0;
    }

    // ---- local player (frozen while dead/paused, world keeps running) ----
    const canPlay = this.state === "playing" && !this.paused;
    const adsScale = 1 / (1 + this.camFeel.adsAmount * (this.weapons.def.ads.zoom - 1));
    const look = input.consumeLook(adsScale * (settings.adsSens * this.camFeel.adsAmount + (1 - this.camFeel.adsAmount)));
    if (canPlay) this.player.applyLook(look.x, look.y);
    this.player.update(dt, canPlay ? input : NO_INPUT);

    if (canPlay) {
      const wheel = input.consumeWheel();
      if (wheel !== 0) this.weapons.cycle(wheel > 0 ? 1 : -1);
      this.weapons.update(dt, this.player);
    }

    const sin = Math.sin(this.player.yaw), cos = Math.cos(this.player.yaw);
    const strafeVel = (this.player.vx * cos - this.player.vz * sin) / 5.7;
    const moving = canPlay && (input.moveForward !== 0 || input.moveRight !== 0);
    this.camFeel.update(dt, this.player, moving, strafeVel);
    this.camera.updateMatrixWorld();
    this.vm.scoped = !!this.weapons.def.ads.scope;
    this.vm.update(dt, look, this.player, moving);

    // ---- network ----
    this._sendT -= dt;
    if (this._sendT <= 0 && this.net.open) {
      this._sendT = SEND_INTERVAL;
      const p = this.player;
      const anim = (moving ? 1 : 0);
      this.net.send({ t: "s", d: [r2(p.x), r2(p.y), r2(p.z), r3(p.yaw), r3(p.pitch), r2(p.crouch), anim, this.weapons.def.id] });
    }
    this.remotes.update(dt, this.net.serverNow() - 130);

    // ---- world ----
    this._rocketing = true;
    this.combat.updateRockets(dt);
    this._rocketing = false;
    this.effects.update(dt, this.camera);
    this.sunburst.update(dt, this.effects);
    if (this.sunburst.rumble > 0.01) this.camFeel.addTrauma(this.sunburst.rumble * dt * 2.4);
    this.hud.setFlash(this.sunburst.flash);
    this.map.skyUpdate(dt, this.camera.position);

    _camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    audio.setListener(this.camera.position, _camRight);
    audio.setIntensity(clamp(this.remotes.aliveCount / 4, 0.25, 1));

    const spread = this.weapons.currentSpread(this.player);
    const fovV = (this.camera.fov * Math.PI) / 180;
    const px = (Math.tan(spread) / Math.tan(fovV / 2)) * (window.innerHeight / 2);
    this.hud.setSpread(px);
    this.hud.setScoreboard(input.down("Tab") && !this.paused, this._scoreHtml());
    this.hud.update(dt, this.camera);
    this.render();
  }

  _scoreHtml() {
    const rows = [...this.scores].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const me = this.net.id;
    return (
      `<div class="mp-score-head"><span>ROOM ${this.roomCode} · FIRST TO ${KILL_TARGET}</span></div>` +
      rows
        .map(
          (r) =>
            `<div class="mp-score-row${r.id === me ? " me" : ""}"><span class="mp-name">${esc(r.name)}${r.id === me ? " (YOU)" : ""}</span><b>${r.kills}</b><em>${r.deaths}</em></div>`
        )
        .join("")
    );
  }

  render() {
    const r = this.engine.renderer;
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    if (this.state === "playing") this.vm.render(r);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm.resize(w / h);
  }

  dispose() {
    for (const u of this._unsubs) u();
    for (const t of ["snap", "join", "leave", "fire", "ult", "hp", "die", "spawn", "over"]) delete this.net.handlers[t];
    if (this._roundPill) this._roundPill.innerHTML = this._roundPillHtml;
    audio.stopMusic();
    this.remotes.dispose();
    this.map.dispose();
    deepDispose(this.scene);
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
