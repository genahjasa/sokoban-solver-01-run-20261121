// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Approach (100% original code, written for this bounty):
// The generator's levels are a 1-wide hallway with 1-4 rooms off it, and a box
// pushed out of its room into the hallway can never come back, so every box
// stays in its room and the push-optimal count P* is the sum of the rooms'
// optima. This solver therefore splits the level into rooms and solves each
// room independently in push space, then stitches the room solutions together
// with plain walks along the hallway.
//
// Per room, a push-space A* runs over states (player square + sorted box
// squares), one cost per push, with:
//   - an admissible heuristic: the min-cost assignment (Hungarian, brute
//     forced over <=4 boxes) of boxes to goals on precomputed shortest-path
//     floor distances, so a completed search returns the push-optimal count;
//   - the player canonicalised to the lowest square of its reachable region,
//     so states that differ only by where the player stands inside one
//     reachable region collapse to one state;
//   - sound deadlock pruning only: dead squares (reverse-push reachability
//     from the goals), permanently immobile boxes, and full 2x2 blocks of
//     boxes/walls holding a non-goal box. Nothing that could still be solved
//     is ever pruned.
// After a room is solved the player must be able to walk back out through
// the door (boxes as obstacles), otherwise it could not reach the next room.
// The unconstrained optimum is tried first; if its end position cannot exit,
// an exit-constrained search runs instead. The one room that cannot exit
// cheaply is solved last, where no exit is needed. If the optimal search
// exhausts its deterministic expansion budget, a weighted A* fallback tries
// to find a (possibly suboptimal) solution rather than leaving the level
// unanswered.
//
// Budgets are deterministic work counts (expansion caps), never the wall
// clock, so two executions write byte-identical output. No randomness.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];
const MAX_EXPANSIONS = 300000;
const FALLBACK_WEIGHT = 3;

// ---------------------------------------------------------------- parsing

function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goals = [];
  const boxes = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#' ? 1 : 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Walk from `from` to `to` over floor squares, treating every box as an
// obstacle (a pure walk, no pushes). Returns lowercase move letters, or null.
function walkPathGlobal(L, from, to, boxSet) {
  const { w, h, wall } = L;
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const pdir = new Int8Array(w * h).fill(-1);
  const q = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === to) break;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || boxSet.has(n) || prev[n] >= 0) continue;
      prev[n] = c;
      pdir[n] = d;
      q.push(n);
    }
  }
  if (prev[to] < 0) return null;
  let s = '';
  let c = to;
  while (c !== from) {
    s = LETTER[pdir[c]] + s;
    c = prev[c];
  }
  return s;
}

// ------------------------------------------------------- per-room solver

function permutations(n) {
  const out = [];
  const cur = [];
  const used = new Array(n).fill(false);
  (function gen() {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      gen();
      cur.pop();
      used[i] = false;
    }
  })();
  return out;
}

// Solve one room. `cells` are the room's floor squares (global indices),
// `entry` is a hallway square next to the room's door, `boxes0`/`goals0`
// the room's boxes/goals (global indices). The player starts on `entry`
// and boxes may only ever sit on room squares.
// Returns { moves, pushes, endPlayer, endBoxes, h0 } in global indices, or
// null when the search gives up (budget exhausted / no solution found).
function solveRoom(L, cells, entry, boxes0, goals0, requireExit, maxExp, weight) {
  const { w, h, wall } = L;
  const at = (x, y) => y * w + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

  const roomSorted = [...cells].sort((a, b) => a - b);
  const roomSet = new Set(roomSorted);
  // Player squares: the room plus every hallway floor square touching it.
  const allowed = new Set(roomSorted);
  for (const c of roomSorted) {
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!inBounds(nx, ny)) continue;
      const n = at(nx, ny);
      if (!wall[n] && !roomSet.has(n)) allowed.add(n);
    }
  }
  const hallSquares = [...allowed].filter((g) => !roomSet.has(g)).sort((a, b) => a - b);
  const allSq = roomSorted.concat(hallSquares);
  const comp = new Map();
  allSq.forEach((g, i) => comp.set(g, i));
  const M = allSq.length;
  const N = roomSorted.length;
  const isRoomSq = (ci) => ci < N;

  // Neighbours over allowed squares: [neighbour compact, direction].
  const neigh = new Array(M);
  for (let i = 0; i < M; i++) {
    const g = allSq[i];
    const x = g % w;
    const y = (g / w) | 0;
    const arr = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!inBounds(nx, ny)) continue;
      const ni = comp.get(at(nx, ny));
      if (ni !== undefined) arr.push([ni, d]);
    }
    neigh[i] = arr;
  }

  const goalIdx = goals0.map((g0) => comp.get(g0));
  const goalSet = new Set(goalIdx);
  const n = boxes0.length;
  const perms = permutations(n);

  // Shortest-path distances (ignoring boxes) from each goal over room squares.
  const distG = goalIdx.map((gi) => {
    const dist = new Int16Array(N).fill(-1);
    dist[gi] = 0;
    const q = [gi];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      for (const [ni] of neigh[c]) {
        if (!isRoomSq(ni) || dist[ni] >= 0) continue;
        dist[ni] = dist[c] + 1;
        q.push(ni);
      }
    }
    return dist;
  });

  // Dead squares: a room square is live when a box on it could reach a goal
  // by reverse pushes (player-stand square only needs to be an allowed
  // square). Anything else can never hold a box that reaches a goal.
  const live = new Uint8Array(N);
  const lq = [];
  for (const gi of goalIdx) {
    if (!live[gi]) {
      live[gi] = 1;
      lq.push(gi);
    }
  }
  for (let qi = 0; qi < lq.length; qi++) {
    const y = lq[qi];
    const gy = roomSorted[y];
    const x = gy % w;
    const yy = (gy / w) | 0;
    for (let d = 0; d < 4; d++) {
      const px = x - DX[d];
      const py = yy - DY[d];
      const sx = x - 2 * DX[d];
      const sy = yy - 2 * DY[d];
      if (!inBounds(px, py) || !inBounds(sx, sy)) continue;
      const pi = comp.get(at(px, py));
      if (pi === undefined || !isRoomSq(pi)) continue;
      if (comp.get(at(sx, sy)) === undefined) continue;
      if (!live[pi]) {
        live[pi] = 1;
        lq.push(pi);
      }
    }
  }

  // Sound deadlock test for one box (never prunes a solvable state):
  //  - on a dead square, or
  //  - permanently immobile: every push direction has either a non-room
  //    target square or a non-allowed stand square (box occupancy is
  //    temporary, so it never counts here), or
  //  - part of a full 2x2 block of boxes/walls (no box in such a block can
  //    ever move: every push needs a target or stand square inside it).
  function boxDead(b, occ) {
    if (goalSet.has(b)) return false;
    if (!live[b]) return true;
    const g = roomSorted[b];
    const x = g % w;
    const y = (g / w) | 0;
    let immobile = true;
    for (let d = 0; d < 4; d++) {
      const tx = x + DX[d];
      const ty = y + DY[d];
      const sx = x - DX[d];
      const sy = y - DY[d];
      const ti = inBounds(tx, ty) ? comp.get(at(tx, ty)) : undefined;
      const si = inBounds(sx, sy) ? comp.get(at(sx, sy)) : undefined;
      if (ti !== undefined && isRoomSq(ti) && si !== undefined) immobile = false;
    }
    if (immobile) return true;
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      let full = true;
      for (let k = 0; k < 4; k++) {
        const bx = x + ox + (k % 2);
        const by = y + oy + ((k / 2) | 0);
        if (!inBounds(bx, by)) continue;
        const bi = comp.get(at(bx, by));
        // A square blocks the block only when no one can use it: a wall, or
        // a box. A free floor square blocks nothing, hallway floor included
        // (the player can stand on it, so a box beside it can be pushed).
        if (bi !== undefined && !occ.has(bi)) {
          full = false;
          break;
        }
      }
      if (full) return true;
    }
    return false;
  }

  // Reachable region from a player square (boxes are obstacles). Returns
  // the region as a visited array plus its lowest compact square, which
  // canonicalises the player position for the state key.
  function regionOf(start, occ) {
    const seen = new Uint8Array(M);
    const q = [start];
    seen[start] = 1;
    let min = start;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (c < min) min = c;
      for (const [ni] of neigh[c]) {
        if (seen[ni]) continue;
        if (isRoomSq(ni) && occ.has(ni)) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    return { seen, min };
  }

  function canExit(playerPos, bxs) {
    const occ = new Set(bxs);
    const r = regionOf(playerPos, occ);
    for (let i = N; i < M; i++) if (r.seen[i]) return true;
    return false;
  }

  function heur(bxs) {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let k = 0; k < n; k++) {
        const dd = distG[p[k]][bxs[k]];
        if (dd < 0) {
          s = Infinity;
          break;
        }
        s += dd;
      }
      if (s < best) best = s;
    }
    return best;
  }

  const isSolved = (bxs) => {
    for (const b of bxs) if (!goalSet.has(b)) return false;
    return true;
  };

  // Walk (no pushes) inside the room between two player squares.
  function walkPathRoom(from, to, occ) {
    if (from === to) return '';
    const prev = new Int32Array(M).fill(-1);
    const pdir = new Int8Array(M).fill(-1);
    const q = [from];
    prev[from] = from;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (c === to) break;
      for (const [ni, d] of neigh[c]) {
        if (prev[ni] >= 0) continue;
        if (isRoomSq(ni) && occ.has(ni)) continue;
        prev[ni] = c;
        pdir[ni] = d;
        q.push(ni);
      }
    }
    if (prev[to] < 0) return null;
    let s = '';
    let c = to;
    while (c !== from) {
      s = LETTER[pdir[c]] + s;
      c = prev[c];
    }
    return s;
  }

  const startBoxes = boxes0.map((g0) => comp.get(g0)).sort((a, b) => a - b);
  const startPlayer = comp.get(entry);
  const h0 = heur(startBoxes);
  if (!isFinite(h0)) return null;
  {
    const occ0 = new Set(startBoxes);
    for (const b of startBoxes) if (boxDead(b, occ0)) return null;
  }

  const keyOf = (bxs, norm) => bxs.join(',') + '|' + norm;
  const best = new Map();
  const par = [];
  const pl = [];
  const bx = [];
  const pg = [];
  const pbox = [];
  const pdir = [];

  const heap = [];
  let seq = 0;
  const hless = (a, b) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  function hpush(e) {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!hless(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  }
  function hpop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && hless(heap[c + 1], heap[c])) c++;
        if (!hless(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  }

  const r0 = regionOf(startPlayer, new Set(startBoxes));
  par.push(-1);
  pl.push(startPlayer);
  bx.push(startBoxes);
  pg.push(0);
  pbox.push(-1);
  pdir.push(-1);
  best.set(keyOf(startBoxes, r0.min), 0);
  hpush([h0 * weight, 0, seq++, 0]);

  let expanded = 0;
  while (heap.length > 0) {
    const [, g, , s] = hpop();
    const bxs = bx[s];
    const rs = regionOf(pl[s], new Set(bxs));
    if (best.get(keyOf(bxs, rs.min)) !== g) continue;
    if (isSolved(bxs) && (!requireExit || canExit(pl[s], bxs))) {
      // Reconstruct the move string from the push chain.
      const chain = [];
      let cur = s;
      while (par[cur] >= 0) {
        chain.push(cur);
        cur = par[cur];
      }
      chain.reverse();
      let moves = '';
      let playerPos = startPlayer;
      let curBoxes = startBoxes;
      for (const st of chain) {
        const b = pbox[st];
        const d = pdir[st];
        const bg = roomSorted[b];
        const x = bg % w;
        const y = (bg / w) | 0;
        const stand = comp.get(at(x - DX[d], y - DY[d]));
        const walk = walkPathRoom(playerPos, stand, new Set(curBoxes));
        if (walk === null) return null;
        moves += walk + LETTER[d].toUpperCase();
        const ti = comp.get(at(x + DX[d], y + DY[d]));
        curBoxes = curBoxes.slice();
        curBoxes[curBoxes.indexOf(b)] = ti;
        curBoxes.sort((a, b2) => a - b2);
        playerPos = b;
      }
      return {
        moves,
        pushes: chain.length,
        endPlayer: allSq[playerPos],
        endBoxes: curBoxes.map((ci) => roomSorted[ci]),
        h0,
      };
    }
    if (expanded >= maxExp) return null;
    expanded++;
    const occ = new Set(bxs);
    for (const b of bxs) {
      const bg = roomSorted[b];
      const x = bg % w;
      const y = (bg / w) | 0;
      for (let d = 0; d < 4; d++) {
        const sx = x - DX[d];
        const sy = y - DY[d];
        const tx = x + DX[d];
        const ty = y + DY[d];
        if (!inBounds(tx, ty)) continue;
        const ti = comp.get(at(tx, ty));
        if (ti === undefined || !isRoomSq(ti) || occ.has(ti)) continue;
        const si = inBounds(sx, sy) ? comp.get(at(sx, sy)) : undefined;
        if (si === undefined || !rs.seen[si]) continue;
        const nb = bxs.slice();
        nb[nb.indexOf(b)] = ti;
        nb.sort((a, b2) => a - b2);
        const nocc = new Set(nb);
        if (boxDead(ti, nocc)) continue;
        const hh = heur(nb);
        if (!isFinite(hh)) continue;
        const ng = g + 1;
        const r2 = regionOf(b, nocc);
        const k2 = keyOf(nb, r2.min);
        const prevBest = best.get(k2);
        if (prevBest !== undefined && prevBest <= ng) continue;
        best.set(k2, ng);
        const idx2 = par.length;
        par.push(s);
        pl.push(b);
        bx.push(nb);
        pg.push(ng);
        pbox.push(b);
        pdir.push(d);
        hpush([ng + weight * hh, ng, seq++, idx2]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------- whole level

function solveLevel(text) {
  const L = parseLevel(text);
  const { w, h, wall, goals, boxes, player } = L;
  if (player < 0 || boxes.length === 0) return '';
  const at = (x, y) => y * w + x;
  const hallRow = (player / w) | 0;

  // Rooms: connected components of floor squares off the hallway row.
  const compId = new Int32Array(w * h).fill(-1);
  const comps = [];
  for (let y = 0; y < h; y++) {
    if (y === hallRow) continue;
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      if (wall[i] || compId[i] >= 0) continue;
      const q = [i];
      compId[i] = comps.length;
      const cells = [];
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi];
        cells.push(c);
        const cx = c % w;
        const cy = (c / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d];
          const ny = cy + DY[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || ny === hallRow) continue;
          const n = at(nx, ny);
          if (wall[n] || compId[n] >= 0) continue;
          compId[n] = comps.length;
          q.push(n);
        }
      }
      comps.push(cells);
    }
  }

  const rooms = [];
  const assignedBoxes = new Set();
  for (const cells of comps) {
    const set = new Set(cells);
    const rboxes = boxes.filter((b) => set.has(b));
    if (rboxes.length === 0) continue;
    const rgoals = goals.filter((g) => set.has(g));
    if (rboxes.length !== rgoals.length) return '';
    for (const b of rboxes) assignedBoxes.add(b);
    const doors = cells
      .filter((c) => {
        const x = c % w;
        const y = (c / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (ny === hallRow && nx >= 0 && nx < w && !wall[at(nx, ny)]) return true;
        }
        return false;
      })
      .sort((a, b) => a - b);
    if (doors.length === 0) return '';
    const d0 = doors[0];
    const dx = d0 % w;
    const dy = (d0 / w) | 0;
    let entry = -1;
    for (let d = 0; d < 4; d++) {
      const nx = dx + DX[d];
      const ny = dy + DY[d];
      if (ny === hallRow && nx >= 0 && nx < w && !wall[at(nx, ny)]) {
        entry = at(nx, ny);
        break;
      }
    }
    if (entry < 0) return '';
    rooms.push({ cells, boxes: rboxes, goals: rgoals, entry });
  }
  if (rooms.length === 0 || assignedBoxes.size !== boxes.length) return '';

  // Solve each room: unconstrained optimum first, then an exit-constrained
  // search only when the optimum ends somewhere the player cannot leave.
  const infos = [];
  for (const r of rooms) {
    let opt = solveRoom(L, r.cells, r.entry, r.boxes, r.goals, false, MAX_EXPANSIONS, 1);
    if (!opt) opt = solveRoom(L, r.cells, r.entry, r.boxes, r.goals, false, MAX_EXPANSIONS, FALLBACK_WEIGHT);
    if (!opt) return '';
    let optExit = opt;
    if (!roomCanExit(L, r, opt)) {
      const ex = solveRoom(L, r.cells, r.entry, r.boxes, r.goals, true, MAX_EXPANSIONS, 1);
      optExit = ex ?? solveRoom(L, r.cells, r.entry, r.boxes, r.goals, true, MAX_EXPANSIONS, FALLBACK_WEIGHT);
    }
    infos.push({ room: r, opt, optExit });
  }

  // Pick the last room (no exit needed there) minimising total pushes.
  let bestTotal = Infinity;
  let bestLast = -1;
  for (let li = 0; li < rooms.length; li++) {
    let t = 0;
    let ok = true;
    for (let i = 0; i < rooms.length; i++) {
      const sol = i === li ? infos[i].opt : infos[i].optExit;
      if (!sol) {
        ok = false;
        break;
      }
      t += sol.pushes;
    }
    if (ok && t < bestTotal) {
      bestTotal = t;
      bestLast = li;
    }
  }
  if (bestLast < 0) return '';

  const order = rooms.map((_, i) => i).filter((i) => i !== bestLast);
  order.push(bestLast);

  let moves = '';
  let playerPos = player;
  let curBoxes = boxes.slice();
  for (const ri of order) {
    const info = infos[ri];
    const sol = ri === bestLast ? info.opt : info.optExit;
    const walk = walkPathGlobal(L, playerPos, info.room.entry, new Set(curBoxes));
    if (walk === null) return '';
    moves += walk + sol.moves;
    const roomBoxSet = new Set(info.room.boxes);
    curBoxes = curBoxes.filter((b) => !roomBoxSet.has(b)).concat(sol.endBoxes);
    playerPos = sol.endPlayer;
  }
  return moves;
}

// Can the player leave this room from the end position of a solution?
// (Recompute by walking from the end position over floor squares, avoiding
// the room's solved boxes, to any hallway square.)
function roomCanExit(L, room, sol) {
  const { w, h, wall } = L;
  const at = (x, y) => y * w + x;
  const hallRow = (L.player / w) | 0;
  const boxSet = new Set(sol.endBoxes);
  const q = [sol.endPlayer];
  const seen = new Set([sol.endPlayer]);
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (((c / w) | 0) === hallRow) return true;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = at(nx, ny);
      if (wall[n] || boxSet.has(n) || seen.has(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return false;
}

// ------------------------------------------------------------------ main

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
