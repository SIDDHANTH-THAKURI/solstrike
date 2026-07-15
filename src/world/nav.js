// Walkable navigation grid + A* for bot pathing. 1m cells over the arena.
// Uses generation stamps instead of clearing arrays between searches.

export class NavGrid {
  constructor(halfExtent, cellSize = 1) {
    this.cell = cellSize;
    this.half = halfExtent;
    this.n = Math.ceil((halfExtent * 2) / cellSize);
    const total = this.n * this.n;
    this.blocked = new Uint8Array(total);
    // A* working arrays
    this._g = new Float32Array(total);
    this._f = new Float32Array(total);
    this._from = new Int32Array(total);
    this._stamp = new Int32Array(total);
    this._closed = new Int32Array(total);
    this._gen = 0;
    this._heap = new Int32Array(total);
    this._heapLen = 0;
  }

  idx(cx, cz) {
    return cz * this.n + cx;
  }
  inBounds(cx, cz) {
    return cx >= 0 && cz >= 0 && cx < this.n && cz < this.n;
  }
  toCellX(x) {
    return Math.floor((x + this.half) / this.cell);
  }
  toCellZ(z) {
    return Math.floor((z + this.half) / this.cell);
  }
  cellCenterX(cx) {
    return cx * this.cell - this.half + this.cell / 2;
  }
  cellCenterZ(cz) {
    return cz * this.cell - this.half + this.cell / 2;
  }
  isOpen(cx, cz) {
    return this.inBounds(cx, cz) && !this.blocked[this.idx(cx, cz)];
  }
  isOpenWorld(x, z) {
    return this.isOpen(this.toCellX(x), this.toCellZ(z));
  }

  blockRect(x0, z0, x1, z1) {
    const cx0 = Math.max(0, this.toCellX(x0));
    const cx1 = Math.min(this.n - 1, this.toCellX(x1));
    const cz0 = Math.max(0, this.toCellZ(z0));
    const cz1 = Math.min(this.n - 1, this.toCellZ(z1));
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) this.blocked[this.idx(cx, cz)] = 1;
  }

  // Nearest open cell to a world position (spiral search).
  nearestOpen(x, z) {
    let cx = Math.max(0, Math.min(this.n - 1, this.toCellX(x)));
    let cz = Math.max(0, Math.min(this.n - 1, this.toCellZ(z)));
    if (this.isOpen(cx, cz)) return this.idx(cx, cz);
    for (let r = 1; r < 14; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (this.isOpen(cx + dx, cz + dz)) return this.idx(cx + dx, cz + dz);
        }
      }
    }
    return -1;
  }

  _heapPush(i) {
    const h = this._heap, f = this._f;
    let c = this._heapLen++;
    h[c] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (f[h[p]] <= f[h[c]]) break;
      const t = h[p]; h[p] = h[c]; h[c] = t;
      c = p;
    }
  }

  _heapPop() {
    const h = this._heap, f = this._f;
    const top = h[0];
    const last = h[--this._heapLen];
    if (this._heapLen > 0) {
      h[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < this._heapLen && f[h[l]] < f[h[m]]) m = l;
        if (r < this._heapLen && f[h[r]] < f[h[m]]) m = r;
        if (m === c) break;
        const t = h[m]; h[m] = h[c]; h[c] = t;
        c = m;
      }
    }
    return top;
  }

  // A* from world (ax,az) to (bx,bz). Fills `outPath` with world-space
  // [x0,z0,x1,z1,...] waypoints (smoothed). Returns waypoint count.
  findPath(ax, az, bx, bz, outPath) {
    const start = this.nearestOpen(ax, az);
    const goal = this.nearestOpen(bx, bz);
    outPath.length = 0;
    if (start < 0 || goal < 0) return 0;
    if (start === goal) {
      outPath.push(bx, bz);
      return 1;
    }

    const n = this.n;
    const gen = ++this._gen;
    const g = this._g, f = this._f, from = this._from, stamp = this._stamp, closed = this._closed;
    const gx = goal % n, gz = (goal / n) | 0;

    this._heapLen = 0;
    g[start] = 0;
    f[start] = 0;
    from[start] = -1;
    stamp[start] = gen;
    this._heapPush(start);

    let found = false;
    let iter = 0;
    const maxIter = n * n;

    while (this._heapLen > 0 && iter++ < maxIter) {
      const cur = this._heapPop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      const cx = cur % n, cz = (cur / n) | 0;

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          const ni = nz * n + nx;
          if (this.blocked[ni] || closed[ni] === gen) continue;
          // no diagonal corner cutting
          if (dx !== 0 && dz !== 0) {
            if (this.blocked[cz * n + nx] || this.blocked[nz * n + cx]) continue;
          }
          const step = dx !== 0 && dz !== 0 ? 1.4142 : 1;
          const ng = g[cur] + step;
          if (stamp[ni] !== gen || ng < g[ni]) {
            stamp[ni] = gen;
            g[ni] = ng;
            const hx = Math.abs(nx - gx), hz = Math.abs(nz - gz);
            f[ni] = ng + Math.max(hx, hz) + 0.41 * Math.min(hx, hz);
            from[ni] = cur;
            this._heapPush(ni);
          }
        }
      }
    }

    if (!found) return 0;

    // reconstruct (cell indices, goal -> start)
    _cellPath.length = 0;
    let c = goal;
    while (c !== -1) {
      _cellPath.push(c);
      c = from[c];
    }
    _cellPath.reverse();

    // smooth: greedily skip waypoints with clear grid LOS
    let i = 0;
    while (i < _cellPath.length - 1) {
      let j = Math.min(i + 10, _cellPath.length - 1);
      while (j > i + 1 && !this._cellLos(_cellPath[i], _cellPath[j])) j--;
      const ci = _cellPath[j];
      outPath.push(this.cellCenterX(ci % n), this.cellCenterZ((ci / n) | 0));
      i = j;
    }
    // last waypoint = true goal position (still on open cell)
    if (outPath.length >= 2) {
      outPath[outPath.length - 2] = this.cellCenterX(goal % n);
      outPath[outPath.length - 1] = this.cellCenterZ((goal / n) | 0);
    }
    return outPath.length / 2;
  }

  // supercover line between two cell indices; true if fully open
  _cellLos(a, b) {
    const n = this.n;
    let x0 = a % n, z0 = (a / n) | 0;
    const x1 = b % n, z1 = (b / n) | 0;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    for (;;) {
      if (this.blocked[z0 * n + x0]) return false;
      if (x0 === x1 && z0 === z1) return true;
      const e2 = 2 * err;
      if (e2 > -dz) {
        err -= dz;
        x0 += sx;
      } else if (e2 < dx) {
        err += dx;
        z0 += sz;
      }
      // step both when perfectly diagonal — also check adjacent cells
      if (e2 > -dz && e2 < dx) {
        if (this.blocked[z0 * n + (x0 - sx)] && this.blocked[(z0 - sz) * n + x0]) return false;
      }
    }
  }

  // Random open cell within a ring around (x,z); returns {x,z} into out or null.
  randomOpenNear(x, z, rMin, rMax, rng, out) {
    for (let tries = 0; tries < 24; tries++) {
      const ang = rng() * Math.PI * 2;
      const r = rMin + rng() * (rMax - rMin);
      const wx = x + Math.cos(ang) * r;
      const wz = z + Math.sin(ang) * r;
      const cx = this.toCellX(wx), cz = this.toCellZ(wz);
      if (this.isOpen(cx, cz)) {
        out.x = this.cellCenterX(cx);
        out.z = this.cellCenterZ(cz);
        return out;
      }
    }
    return null;
  }
}

const _cellPath = [];
