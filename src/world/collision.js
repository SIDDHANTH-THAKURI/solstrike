// Static world collision: axis-aligned boxes with a uniform grid broadphase
// for movement queries and a brute-force slab raycast (box count is small
// enough that rays don't need the grid). All methods are allocation-free in
// steady state — results write into caller-provided scratch objects.

export class StaticWorld {
  constructor(halfExtent) {
    this.half = halfExtent;
    this.boxes = []; // {x0,y0,z0,x1,y1,z1, thin}
    this.cell = 4;
    this.grid = new Map(); // "cx,cz" -> number[]
  }

  addBox(x0, y0, z0, x1, y1, z1) {
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (z1 < z0) [z0, z1] = [z1, z0];
    const b = { x0, y0, z0, x1, y1, z1 };
    // "thin" walls (≤0.4m) can be shot through with damage falloff
    b.thin = Math.min(x1 - x0, z1 - z0) <= 0.4 && y1 - y0 > 0.5;
    this.boxes.push(b);
    return b;
  }

  finalize() {
    this.grid.clear();
    const c = this.cell;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const cx0 = Math.floor(b.x0 / c), cx1 = Math.floor(b.x1 / c);
      const cz0 = Math.floor(b.z0 / c), cz1 = Math.floor(b.z1 / c);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = cx + "," + cz;
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(i);
        }
      }
    }
  }

  // Gather indices of boxes possibly overlapping the AABB into `out`.
  query(x0, z0, x1, z1, out) {
    out.length = 0;
    const c = this.cell;
    const cx0 = Math.floor(x0 / c), cx1 = Math.floor(x1 / c);
    const cz0 = Math.floor(z0 / c), cz1 = Math.floor(z1 / c);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.grid.get(cx + "," + cz);
        if (arr) {
          for (let i = 0; i < arr.length; i++) {
            if (out.indexOf(arr[i]) === -1) out.push(arr[i]);
          }
        }
      }
    }
    return out;
  }

  // Slab-method raycast vs all boxes + ground plane (y=0).
  // Writes into `hit` {t, nx, ny, nz, box} and returns true when something
  // is hit within maxD.
  raycast(ox, oy, oz, dx, dy, dz, maxD, hit) {
    let bestT = maxD;
    let bestBox = null;
    let bnx = 0, bny = 0, bnz = 0;

    // ground plane
    if (dy < -1e-8 && oy > 0) {
      const t = -oy / dy;
      if (t < bestT) {
        bestT = t;
        bestBox = null;
        bnx = 0; bny = 1; bnz = 0;
        hit.ground = true;
      }
    }

    const inv = 1e30;
    const idx = dx !== 0 ? 1 / dx : inv;
    const idy = dy !== 0 ? 1 / dy : inv;
    const idz = dz !== 0 ? 1 / dz : inv;

    const boxes = this.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      let tmin, tmax, axis;

      let t1 = (b.x0 - ox) * idx;
      let t2 = (b.x1 - ox) * idx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = t1; tmax = t2; axis = 0;

      t1 = (b.y0 - oy) * idy;
      t2 = (b.y1 - oy) * idy;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; axis = 1; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;

      t1 = (b.z0 - oz) * idz;
      t2 = (b.z1 - oz) * idz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) { tmin = t1; axis = 2; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;

      if (tmin < 0 || tmin >= bestT) continue;

      bestT = tmin;
      bestBox = b;
      hit.ground = false;
      if (axis === 0) { bnx = dx > 0 ? -1 : 1; bny = 0; bnz = 0; }
      else if (axis === 1) { bnx = 0; bny = dy > 0 ? -1 : 1; bnz = 0; }
      else { bnx = 0; bny = 0; bnz = dz > 0 ? -1 : 1; }
    }

    if (bestT < maxD) {
      hit.t = bestT;
      hit.nx = bnx; hit.ny = bny; hit.nz = bnz;
      hit.box = bestBox;
      return true;
    }
    return false;
  }

  // Cheap boolean line-of-sight (no hit details, early out).
  losBlocked(ox, oy, oz, tx, ty, tz) {
    let dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-5) return false;
    dx /= d; dy /= d; dz /= d;
    return this.raycast(ox, oy, oz, dx, dy, dz, d - 0.05, _losHit);
  }
}

const _losHit = {};
