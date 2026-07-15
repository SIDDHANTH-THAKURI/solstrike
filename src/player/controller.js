// First-person character controller tuned for a crisp, tactical feel:
// instant-feeling ground acceleration, hard stops (counter-strafing works),
// low jump, step-up for stairs, walk/crouch modifiers. Collision is
// axis-separated AABB sweep against the static world.

import { clamp, damp } from "../core/utils.js";

const GRAVITY = 26;
const JUMP_SPEED = 7.6;
const RUN_SPEED = 5.7;
const WALK_SPEED = 3.0;
const CROUCH_SPEED = 2.1;
const GROUND_ACCEL = 62;
const GROUND_FRICTION = 68;
const AIR_ACCEL = 13;
const STEP_HEIGHT = 0.56;
const RADIUS = 0.42;
const HEIGHT_STAND = 1.78;
const HEIGHT_CROUCH = 1.26;

export class PlayerController {
  constructor(world, half) {
    this.world = world;
    this.half = half;
    this.x = 0; this.y = 0; this.z = 0; // feet position
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
    this.crouch = 0; // smoothed 0..1
    this.height = HEIGHT_STAND;
    this._candidates = [];
    this._stepTimer = 0;
    this._airTime = 0;
    this._jumpBuffer = 0;
    this._fallPeak = 0;
    // events
    this.onFootstep = null;
    this.onLand = null;
    this.onJump = null;
    // modifiers set by weapon system
    this.speedMult = 1;
  }

  reset(x, z, yaw) {
    this.x = x; this.y = 0; this.z = z;
    this.vx = this.vy = this.vz = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = true;
    this.crouch = 0;
  }

  get eyeY() {
    return this.y + this.height - 0.16;
  }

  get speed2D() {
    return Math.sqrt(this.vx * this.vx + this.vz * this.vz);
  }

  applyLook(dx, dy) {
    this.yaw -= dx;
    this.pitch = clamp(this.pitch - dy, -1.53, 1.53);
  }

  impulse(ix, iy, iz) {
    this.vx += ix;
    this.vy += iy;
    this.vz += iz;
    if (iy > 0) this.grounded = false;
  }

  update(dt, input) {
    // --- stance -------------------------------------------------------------
    const wantCrouch = input.crouching ? 1 : 0;
    this.crouch = damp(this.crouch, wantCrouch, 14, dt);
    const targetH = HEIGHT_STAND - (HEIGHT_STAND - HEIGHT_CROUCH) * this.crouch;
    // don't stand into a ceiling
    if (targetH > this.height) {
      if (!this._overlaps(this.x, this.y, this.z, targetH)) this.height = targetH;
    } else {
      this.height = targetH;
    }

    // --- wish direction -------------------------------------------------------
    const f = input.moveForward;
    const r = input.moveRight;
    let wx = 0, wz = 0;
    if (f !== 0 || r !== 0) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      wx = -sin * f + cos * r;
      wz = -cos * f - sin * r;
      const len = Math.sqrt(wx * wx + wz * wz);
      wx /= len; wz /= len;
    }

    let maxSpeed = RUN_SPEED;
    if (input.walking) maxSpeed = WALK_SPEED;
    if (this.crouch > 0.5) maxSpeed = CROUCH_SPEED;
    maxSpeed *= this.speedMult;

    // --- horizontal velocity --------------------------------------------------
    if (this.grounded) {
      if (wx !== 0 || wz !== 0) {
        // accelerate toward wish velocity, allow instant direction changes
        const tx = wx * maxSpeed, tz = wz * maxSpeed;
        const ax = tx - this.vx, az = tz - this.vz;
        const alen = Math.sqrt(ax * ax + az * az);
        if (alen > 0.0001) {
          const a = Math.min(GROUND_ACCEL * dt, alen);
          this.vx += (ax / alen) * a;
          this.vz += (az / alen) * a;
        }
      } else {
        // friction stop — fast, crisp
        const sp = this.speed2D;
        if (sp > 0.001) {
          const drop = GROUND_FRICTION * dt;
          const ns = Math.max(sp - drop, 0);
          this.vx *= ns / sp;
          this.vz *= ns / sp;
        }
      }
    } else if (wx !== 0 || wz !== 0) {
      // limited air control
      this.vx += wx * AIR_ACCEL * dt;
      this.vz += wz * AIR_ACCEL * dt;
      const sp = this.speed2D;
      if (sp > maxSpeed) {
        this.vx *= maxSpeed / sp;
        this.vz *= maxSpeed / sp;
      }
    }

    // --- jump -------------------------------------------------------------
    if (input.jumping) this._jumpBuffer = 0.12;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    const coyote = this._airTime < 0.08;
    if (this._jumpBuffer > 0 && (this.grounded || coyote) && this.vy <= 0.01) {
      this.vy = JUMP_SPEED * (1 - this.crouch * 0.25);
      this.grounded = false;
      this._jumpBuffer = 0;
      this._airTime = 1;
      if (this.onJump) this.onJump();
    }

    // --- gravity ----------------------------------------------------------
    this.vy -= GRAVITY * dt;
    this.vy = Math.max(this.vy, -40);
    if (!this.grounded) this._fallPeak = Math.max(this._fallPeak, -this.vy);

    // --- integrate with collision ------------------------------------------
    const wasGrounded = this.grounded;
    this._moveAxis(0, this.vx * dt);
    this._moveAxis(2, this.vz * dt);
    this.grounded = false;
    this._moveAxis(1, this.vy * dt);

    // ground plane
    if (this.y <= 0) {
      this.y = 0;
      if (this.vy < 0) this.vy = 0;
      this.grounded = true;
    }

    // snap down small ledges when walking (keeps stairs smooth)
    if (wasGrounded && !this.grounded && this.vy <= 0.01) {
      const drop = this._dropDistance(0.5);
      if (drop >= 0) {
        this.y -= drop;
        this.grounded = true;
        this.vy = 0;
      }
    }

    if (this.grounded) {
      this._airTime = 0;
      if (!wasGrounded) {
        if (this.onLand) this.onLand(this._fallPeak);
        this._fallPeak = 0;
      }
    } else {
      this._airTime += dt;
    }

    // arena bounds safety
    const lim = this.half + 2;
    this.x = clamp(this.x, -lim, lim);
    this.z = clamp(this.z, -lim, lim);

    // --- footsteps ----------------------------------------------------------
    const sp = this.speed2D;
    if (this.grounded && sp > 1.2) {
      this._stepTimer -= dt * sp;
      if (this._stepTimer <= 0) {
        this._stepTimer = 3.4; // distance-based cadence
        if (this.onFootstep) this.onFootstep(sp > WALK_SPEED + 0.4);
      }
    } else {
      this._stepTimer = Math.min(this._stepTimer, 1.2);
    }
  }

  _overlaps(x, y, z, h) {
    const cands = this.world.query(x - RADIUS, z - RADIUS, x + RADIUS, z + RADIUS, this._candidates);
    const boxes = this.world.boxes;
    for (let i = 0; i < cands.length; i++) {
      const b = boxes[cands[i]];
      if (
        x - RADIUS < b.x1 && x + RADIUS > b.x0 &&
        y < b.y1 && y + h > b.y0 &&
        z - RADIUS < b.z1 && z + RADIUS > b.z0
      ) return b;
    }
    return null;
  }

  _moveAxis(axis, delta) {
    if (delta === 0) return;
    if (axis === 0) this.x += delta;
    else if (axis === 1) this.y += delta;
    else this.z += delta;

    const hit = this._overlaps(this.x, this.y, this.z, this.height);
    if (!hit) return;

    if (axis === 1) {
      if (delta < 0) {
        this.y = hit.y1;
        this.vy = 0;
        this.grounded = true;
      } else {
        this.y = hit.y0 - this.height;
        this.vy = Math.min(this.vy, 0);
      }
      return;
    }

    // horizontal hit: try stepping up (stairs / low ledges)
    if (this.grounded || this._airTime < 0.12) {
      const stepY = hit.y1;
      if (stepY - this.y > 0.01 && stepY - this.y <= STEP_HEIGHT) {
        if (!this._overlaps(this.x, stepY + 0.001, this.z, this.height)) {
          this.y = stepY + 0.001;
          return;
        }
      }
    }

    if (axis === 0) {
      this.x = delta > 0 ? hit.x0 - RADIUS : hit.x1 + RADIUS;
      this.vx = 0;
    } else {
      this.z = delta > 0 ? hit.z0 - RADIUS : hit.z1 + RADIUS;
      this.vz = 0;
    }
  }

  // distance to ground below within maxDrop, or -1
  _dropDistance(maxDrop) {
    for (let d = 0.05; d <= maxDrop; d += 0.05) {
      if (this.y - d <= 0) return this.y; // ground plane
      if (this._overlaps(this.x, this.y - d, this.z, this.height)) {
        return d - 0.05;
      }
    }
    return -1;
  }
}
