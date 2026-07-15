// One match = one Session. Owns the scene, map, player, bots, weapons,
// effects, round flow, scoring and HUD wiring. Created on match start,
// disposed on quit/end-rematch.

import * as THREE from "three";
import { buildMap } from "../world/mapgen.js";
import { PlayerController } from "../player/controller.js";
import { CameraFeel } from "../player/camerafeel.js";
import { ViewModel } from "../weapons/viewmodel.js";
import { WeaponSystem } from "../weapons/weapons.js";
import { Effects } from "../effects/effects.js";
import { Sunburst } from "../effects/sunburst.js";
import { BotManager } from "../enemies/bots.js";
import { Combat } from "./combat.js";
import { Pickups } from "./pickups.js";
import { input } from "../core/input.js";
import { audio } from "../core/audio.js";
import { settings } from "../core/settings.js";
import { deepDispose } from "../core/engine.js";
import { clamp, formatTime } from "../core/utils.js";

const TOTAL_ROUNDS = 13;

const DIFFICULTY = {
  casual: { hpMult: 0.8, accBase: 0.26, accRamp: 0.008, dmg: 8, speed: 2.6, cooldown: 1.6, cap: 5, label: "CASUAL" },
  standard: { hpMult: 1.0, accBase: 0.36, accRamp: 0.011, dmg: 11, speed: 3.0, cooldown: 1.15, cap: 6, label: "STANDARD" },
  elite: { hpMult: 1.2, accBase: 0.47, accRamp: 0.013, dmg: 14, speed: 3.4, cooldown: 0.85, cap: 7, label: "ELITE" },
};

const _camRight = new THREE.Vector3();
const _listenPos = new THREE.Vector3();
const _ultHit = {};

export class Session {
  constructor(engine, hud, opts) {
    this.engine = engine;
    this.hud = hud;
    this.opts = opts; // {map, difficulty, onEnd(result), onPauseRequest()}
    this.diff = DIFFICULTY[opts.difficulty] || DIFFICULTY.standard;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.06, 600);

    const seed = (Math.random() * 2 ** 31) | 0;
    this.map = buildMap(this.scene, opts.map, seed);
    engine.configureLight(this.map.lights.dir);

    this.player = new PlayerController(this.map.statics, this.map.half);
    this.player.reset(this.map.playerSpawn.x, this.map.playerSpawn.z, this.map.playerSpawn.yaw);
    this.camFeel = new CameraFeel(this.camera);

    this.effects = new Effects(this.scene);
    this.sunburst = new Sunburst(this.scene);
    this.bots = new BotManager(this.scene);
    this.vm = new ViewModel(this.camera, this.scene);
    this.vm.resize(window.innerWidth / window.innerHeight);
    this.weapons = new WeaponSystem(this.vm, this.camFeel, this.camera);
    this.combat = new Combat(this.map.statics, this.bots, this.effects, this.player, this.camFeel);
    this.combat.initRockets(this.scene);
    this.weapons.combat = this.combat;
    this.pickups = new Pickups(this.scene, this.map.pickups);

    // ---- state ----
    this.state = "starting"; // starting | playing | intermission | over
    this.paused = false;
    this.round = 0;
    this.hp = 100;
    this.shield = 50;
    this.timeElapsed = 0;
    this._interT = 0;
    this._spawnQueue = [];
    this._spawnT = 0;
    this._pendingEnemies = 0;
    this._roundStartTime = 0;

    this.stats = {
      kills: 0, headshots: 0, shots: 0, hits: 0,
      damage: 0, bestStreak: 0, score: 0, roundsCleared: 0,
    };
    this._killChain = 0;
    this._killChainT = 0;
    this._shotHadHit = false;
    this.ult = 0; // SUNBURST charge 0..1
    this._ultReadyAnnounced = false;

    this._wireEvents();
    this._botCtx = {
      player: this.player,
      statics: this.map.statics,
      nav: this.map.nav,
      effects: this.effects,
      bots: null,
      onPlayerHit: (dmg, fx, fz) => this._damagePlayer(dmg, fx, fz, false),
    };

    // HUD initial
    hud.reset();
    hud.show();
    hud.setRound(1, TOTAL_ROUNDS);
    hud.setEnemies(0);
    hud.setHealth(this.hp, this.shield);
    hud.setWeaponRail(this.weapons.hudState());
    hud.setAmmo(25, 100);

    this.weapons.resetAll();
    audio.startMusic("combat");
    audio.setIntensity(0.2);

    // opening announce → first round
    this._startT = 1.15;
    hud.announce("SOLSTRIKE", this.map.label + " · " + this.diff.label, { hold: 1.0 });
    audio.stinger("roundStart");
  }

  _wireEvents() {
    this.weapons.onAmmoChange = () => {
      const s = this.weapons.slotState;
      this.hud.setAmmo(s.mag, s.reserve);
      this.hud.setWeaponRail(this.weapons.hudState());
      // count trigger pulls (any weapon fire lowers mag)
    };
    this.weapons.onWeaponChange = () => this.hud.setWeaponRail(this.weapons.hudState());
    this.weapons.onScopeChange = (on) => this.hud.setScope(on);

    // shot accounting: hook into combat dispatch
    const origHitscan = this.combat.fireHitscan.bind(this.combat);
    this.combat.fireHitscan = (o, d, def, m) => {
      if (!this._countedThisShot) {
        this._countedThisShot = true;
        this.stats.shots++;
        this._shotHadHit = false;
        queueMicrotask(() => (this._countedThisShot = false));
      }
      origHitscan(o, d, def, m);
    };
    const origRocket = this.combat.fireRocket.bind(this.combat);
    this.combat.fireRocket = (o, d, def) => {
      this.stats.shots++;
      this._shotHadHit = false;
      origRocket(o, d, def);
    };

    this.combat.onBotDamaged = (dmg, part, killed, bot, px, py, pz) => {
      this.stats.damage += dmg;
      this._gainUlt(dmg / 3200);
      if (!this._shotHadHit) {
        this._shotHadHit = true;
        this.stats.hits++;
      }
      this.hud.hitmark(killed, part === "head");
      this.hud.damageNumber(px, py, pz, dmg, part === "head", this.camera);
      if (part === "head") audio.headshot();
      else audio.hitmark();
    };

    this.combat.onBotKilled = (bot, part, cause) => {
      this.stats.kills++;
      audio.killConfirm();
      this._gainUlt(part === "head" ? 0.17 : 0.13);

      // scoring
      let pts = 100;
      let feed = "SPECTRE DOWN";
      let accent = "";
      if (part === "head" && cause === "shot") {
        pts += 50;
        this.stats.headshots++;
        accent = "HEADSHOT";
      }
      if (cause === "rocket") accent = "BOOM";
      if (cause === "sunburst") {
        feed = "VAPORIZED";
        accent = "SUNBURST";
      }
      this._killChainT = 2.6;
      this._killChain++;
      if (this._killChain >= 2) pts += 40 * (this._killChain - 1);
      this.stats.bestStreak = Math.max(this.stats.bestStreak, this._killChain);
      const chainNames = { 2: "DOUBLE KILL", 3: "TRIPLE KILL", 4: "QUAD KILL", 5: "RAMPAGE" };
      if (chainNames[this._killChain]) {
        this.hud.announce(chainNames[this._killChain], "+" + pts, { accent: true, hold: 0.9 });
      }
      this.stats.score += pts;
      this.hud.killfeedPush(feed + " · +" + pts, accent);

      const alive = this.bots.aliveCount;
      this.hud.setEnemies(alive + this._pendingEnemies);
      audio.setIntensity(clamp((alive + this._pendingEnemies) / 6, 0.15, 1));
      if (alive === 1 && this._pendingEnemies === 0) audio.stinger("lastEnemy");
      if (alive === 0 && this._pendingEnemies === 0 && this.state === "playing") {
        this._roundCleared();
      }
    };

    this.combat.onPlayerDamaged = (dmg, fx, fz, explosion) => {
      this._damagePlayer(dmg, fx, fz, explosion);
    };

    // player event sounds
    this.player.onFootstep = (run) => audio.footstep(run, true);
    this.player.onJump = () => {};
    this.player.onLand = (fallSpeed) => {
      if (fallSpeed > 3) {
        audio.jumpLand(fallSpeed > 9);
        this.camFeel.landDip(clamp(fallSpeed / 9, 0.25, 1.4));
        this.vm.bump(clamp(fallSpeed / 12, 0.1, 0.8));
      }
    };

    // discrete keys
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

  _ifPlaying(fn) {
    if (!this.paused && this.state !== "over" && input.locked) fn();
  }

  // ------------------------------------------------------------- SUNBURST

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
    // aim point: where the crosshair meets the world (or 40m out), clamped
    // into the arena — the strike is vertical so only x/z matter
    const cam = this.camera;
    cam.getWorldDirection(_camRight); // reuse scratch vector for forward here
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
    this.sunburst.fire(ix, iz, (bx, bz) => {
      _listenPos.set(bx, 1, bz);
      audio.ultBlast(_listenPos);
      this.combat.sunburstBlast(bx, bz);
    });
  }

  // ---------------------------------------------------------------- rounds

  _botConfigForRound(r) {
    const d = this.diff;
    return {
      hp: Math.round((78 + r * 7) * d.hpMult),
      speed: d.speed + r * 0.05,
      accuracy: clamp(d.accBase + r * d.accRamp, 0, 0.8),
      damage: d.dmg,
      burst: 3 + Math.floor(r / 5),
      cooldown: Math.max(d.cooldown - r * 0.03, 0.55),
      engageRange: 24 + r * 0.5,
      rangeNear: 7,
      rangeFar: 15,
      accent: "#e5484d",
    };
  }

  _botsForRound(r) {
    return Math.min(2 + Math.ceil(r * 0.55), this.diff.cap) + (r === TOTAL_ROUNDS ? 1 : 0);
  }

  _startRound() {
    this.round++;
    this.state = "playing";
    this._roundStartTime = this.timeElapsed;
    this.hud.setRound(this.round, TOTAL_ROUNDS);
    this.hud.announce("ROUND " + this.round, this.round === TOTAL_ROUNDS ? "FINAL ROUND — CLEAR THEM ALL" : "ELIMINATE THE SQUAD", { hold: 1.3 });
    audio.stinger("roundStart");

    // spawn plan: shuffled spawn points far from player
    const cfg = this._botConfigForRound(this.round);
    const n = this._botsForRound(this.round);
    const p = this.player;
    const pts = this.map.botSpawns
      .filter(([x, z]) => (x - p.x) ** 2 + (z - p.z) ** 2 > 15 * 15)
      .sort(() => Math.random() - 0.5);
    this._spawnQueue.length = 0;
    for (let i = 0; i < n; i++) {
      const [x, z] = pts[i % pts.length];
      // jitter, but never off the walkable grid (would trap the bot)
      let jx = x + (Math.random() - 0.5) * 1.6;
      let jz = z + (Math.random() - 0.5) * 1.6;
      if (!this.map.nav.isOpenWorld(jx, jz)) {
        jx = x;
        jz = z;
      }
      this._spawnQueue.push({ x: jx, z: jz, cfg, stagger: i });
    }
    this._pendingEnemies = n;
    this._spawnT = 0.45;
    this.hud.setEnemies(n);
    audio.setIntensity(clamp(n / 6, 0.2, 1));
  }

  _roundCleared() {
    this.stats.roundsCleared = this.round;
    const roundTime = this.timeElapsed - this._roundStartTime;
    const timeBonus = Math.round(clamp(1 - roundTime / 45, 0, 1) * 300);
    const pts = 200 + timeBonus;
    this.stats.score += pts;

    if (this.round >= TOTAL_ROUNDS) {
      this._endMatch(true);
      return;
    }

    this.state = "intermission";
    this._interT = 4.2;
    // heal up between rounds
    this.hp = Math.min(100, this.hp + 45);
    this.shield = Math.min(50, this.shield + 25);
    this.hud.setHealth(this.hp, this.shield);
    this.hud.announce("ROUND CLEARED", "+" + pts + (timeBonus > 150 ? " · LIGHTNING FAST" : ""), { accent: true, hold: 1.6 });
    audio.stinger("roundClear");
    audio.setIntensity(0.15);
  }

  _damagePlayer(dmg, fx, fz, explosion) {
    if (this.state === "over" || this.hp <= 0) return;

    // shield absorbs first
    let remaining = dmg;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      if (this.shield === 0 && absorbed > 0) audio.shieldBreak();
      this.effects.shieldSpark(this.player.x, this.player.eyeY - 0.2, this.player.z);
    }
    this.hp -= remaining;
    this.hud.setHealth(this.hp, this.shield);
    this.hud.hurtFlash(clamp(dmg / 20, 0.4, 1));
    audio.hurt();
    this.camFeel.addTrauma(explosion ? 0.35 : 0.16);

    // direction arc (relative to view yaw)
    const worldAng = Math.atan2(fx - this.player.x, fz - this.player.z);
    let rel = worldAng - this.player.yaw + Math.PI;
    const deg = (rel * 180) / Math.PI;
    this.hud.damageArc(deg);

    if (this.hp <= 0) {
      this.hp = 0;
      this.hud.setHealth(0, this.shield);
      this._endMatch(false);
    }
  }

  _endMatch(victory) {
    if (this.state === "over") return;
    this.state = "over";
    audio.stopMusic();
    audio.stinger(victory ? "victory" : "defeat");
    this.hud.announce(victory ? "ARENA CLEARED" : "DOWN", victory ? "FLAWLESS OPERATOR" : "THE SQUAD GOT YOU", { accent: victory, hold: 1.4 });

    // rank (victory only)
    let rank = null;
    if (victory) {
      let totalBots = 0;
      for (let r = 1; r <= TOTAL_ROUNDS; r++) totalBots += this._botsForRound(r);
      const maxScore = totalBots * 150 + TOTAL_ROUNDS * 500;
      const k = this.stats.score / maxScore;
      rank = k > 0.78 ? "S" : k > 0.62 ? "A" : k > 0.45 ? "B" : "C";
    }

    setTimeout(() => {
      input.releaseLock();
      this.opts.onEnd({
        victory,
        rank,
        stats: { ...this.stats },
        time: this.timeElapsed,
        map: this.map.label,
        round: this.round,
      });
    }, 1500);
  }

  // ---------------------------------------------------------------- frame

  setPaused(p) {
    this.paused = p;
    if (p) this.hud.setScoreboard(false);
    this.hud.crosshair.style.visibility = p ? "hidden" : "visible";
  }

  update(dt) {
    if (this.paused || this.state === "over") {
      // freeze sim; keep rendering current frame
      this.render();
      return;
    }

    this.timeElapsed += dt;
    this.hud.setTimer(this.timeElapsed);

    // opening delay → round 1
    if (this.state === "starting") {
      this._startT -= dt;
      if (this._startT <= 0) this._startRound();
    }

    // intermission countdown
    if (this.state === "intermission") {
      const prev = Math.ceil(this._interT);
      this._interT -= dt;
      const now = Math.ceil(this._interT);
      if (now !== prev && now <= 3 && now >= 1) {
        this.hud.announce("NEXT ROUND", "" + now, { hold: 0.7 });
        audio.countBeep(false);
      }
      if (this._interT <= 0) this._startRound();
    }

    // staggered bot spawns
    if (this._spawnQueue.length > 0) {
      this._spawnT -= dt;
      if (this._spawnT <= 0) {
        this._spawnT = 0.4;
        const s = this._spawnQueue.shift();
        const bot = this.bots.spawn(s.x, s.z, s.cfg, s.stagger);
        if (bot) {
          this._pendingEnemies--;
          this.effects.spawnBeamFx(s.x, s.z);
          _listenPos.set(s.x, 1, s.z);
          audio.spawnBeam(_listenPos);
        } else {
          this._spawnQueue.push(s); // pool full; retry later
          this._spawnT = 0.8;
        }
      }
    }

    // kill chain decay
    if (this._killChainT > 0) {
      this._killChainT -= dt;
      if (this._killChainT <= 0) this._killChain = 0;
    }

    // ---- player ----
    const adsScale = 1 / (1 + (this.camFeel.adsAmount * (this.weapons.def.ads.zoom - 1)));
    const look = input.consumeLook(adsScale * (settings.adsSens * this.camFeel.adsAmount + (1 - this.camFeel.adsAmount)));
    this.player.applyLook(look.x, look.y);
    this.player.update(dt, input);

    // wheel weapon cycling
    const wheel = input.consumeWheel();
    if (wheel !== 0) this.weapons.cycle(wheel > 0 ? 1 : -1);

    this.weapons.update(dt, this.player);

    // strafe value for camera roll
    const sin = Math.sin(this.player.yaw), cos = Math.cos(this.player.yaw);
    const strafeVel = (this.player.vx * cos - this.player.vz * sin) / 5.7;

    const moving = input.moveForward !== 0 || input.moveRight !== 0;
    this.camFeel.update(dt, this.player, moving, strafeVel);
    this.camera.updateMatrixWorld();

    this.vm.scoped = !!this.weapons.def.ads.scope;
    this.vm.update(dt, look, this.player, moving);

    // ---- world ----
    this._botCtx.bots = this.bots.bots;
    this.bots.update(dt, this._botCtx);
    this.combat.updateRockets(dt);
    this.effects.update(dt, this.camera);
    this.sunburst.update(dt, this.effects);
    if (this.sunburst.rumble > 0.01) this.camFeel.addTrauma(this.sunburst.rumble * dt * 2.4);
    this.hud.setFlash(this.sunburst.flash);
    this.map.skyUpdate(dt, this.camera.position);
    this.pickups.update(dt, this.player, (kind) => this._tryPickup(kind));

    // audio listener
    _camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    audio.setListener(this.camera.position, _camRight);

    // crosshair spread in px
    const spread = this.weapons.currentSpread(this.player);
    const fovV = (this.camera.fov * Math.PI) / 180;
    const px = (Math.tan(spread) / Math.tan(fovV / 2)) * (window.innerHeight / 2);
    this.hud.setSpread(px);

    // scoreboard hold
    this.hud.setScoreboard(input.down("Tab"), this._statsHtml());

    this.hud.update(dt, this.camera);

    this.render();
  }

  _tryPickup(kind) {
    if (kind === "health") {
      if (this.hp >= 100 && this.shield >= 50) return false;
      this.hp = Math.min(100, this.hp + 40);
      this.shield = Math.min(50, this.shield + 15);
      this.hud.setHealth(this.hp, this.shield);
      this.hud.pickupToast("+ MEDKIT");
      return true;
    }
    // ammo
    let need = false;
    for (const s of this.weapons.inv.values()) {
      if (s.reserve < s.def.reserve) need = true;
    }
    if (!need) return false;
    this.weapons.addAmmo();
    this.hud.pickupToast("+ AMMO RESTOCKED");
    return true;
  }

  _statsHtml() {
    const s = this.stats;
    const acc = s.shots > 0 ? Math.round((s.hits / s.shots) * 100) : 0;
    const cells = [
      [s.score, "SCORE"],
      [this.round + "/" + TOTAL_ROUNDS, "ROUND"],
      [s.kills, "KILLS"],
      [s.headshots, "HEADSHOTS"],
      [acc + "%", "ACCURACY"],
      [formatTime(this.timeElapsed), "TIME"],
    ];
    return cells.map(([v, l]) => `<div class="stat-cell"><b>${v}</b><span>${l}</span></div>`).join("");
  }

  render() {
    const r = this.engine.renderer;
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    if (this.state !== "over") this.vm.render(r);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm.resize(w / h);
  }

  dispose() {
    for (const u of this._unsubs) u();
    audio.stopMusic();
    this.map.dispose();
    this.pickups.dispose();
    deepDispose(this.scene);
  }
}
