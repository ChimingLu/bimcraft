/* SPDX-License-Identifier: Apache-2.0 */
/**
 * drainage.js — sanitary drains sized by the fixture units they carry. DOM-free, no IFC: mep-model.js gives it the runs and the
 * fixtures' drain connectors in world mm and writes the sizes back.
 *
 * Tables (fixture units a horizontal drain carries, by its size):
 *   NBR 8160 (Brazil, UHC, DN in mm): branches ("ramais de esgoto") DN 40: 3, 50: 6, 75: 20, 100: 160; building drains and
 *     collectors ("subcoletores e coletor predial") by slope 0.5 / 1 / 2 / 4 %: DN 100: — / 180 / 216 / 250, DN 150: — / 700 /
 *     840 / 1000, DN 200: 1400 / 1600 / 1920 / 2300.
 *   International Plumbing Code 2021 (DFU, inches): Table 710.1(2) horizontal fixture branches 1-1/2: 3, 2: 6, 2-1/2: 12, 3: 20,
 *     4: 160, 5: 360, 6: 620, 8: 1400, 10: 2500, 12: 3900; Table 710.1(1) building drains by slope 1/16 / 1/8 / 1/4 / 1/2 in. per
 *     foot (2: — / — / 21 / 26 … 4: — / 180 / 216 / 250 … 8: 1400 / 1600 / 1920 / 2300).
 *   A drain is never smaller than the fixture drains it serves (a water closet: DN 100 / 3 in.) nor than a drain flowing into it;
 *   under NBR 8160 a building drain ("coletor predial") is DN 100 at least (MAIN_MIN_DN).
 *   A size a branch table does not list is looked up in the building-drain table at the run's slope (and the other way round).
 *
 *   drainNetwork(runs, fixtures) → Map(guid → { uhc, dfu, minDn, minIn, up: [guid], down: guid | null, fixtures: [ids] })
 *     runs: [{ guid, verts (world mm, in the way it flows: first point upstream), od }]; fixtures: [{ id, p (world mm), size,
 *     kind (mep/fixtures.js) }] — the drain connectors of plumbing fixtures. A run flows into the run its last point lies on; a
 *     fixture drains into the run that passes through its connector.
 *   capacity(std, nominal, slope, role) → fixture units, or 0 when the size does not carry any at that slope
 *   smallestSize(std, sizes, units, { slope, role, floor }) → the first of `sizes` ([{ key, nominal }], smallest first) that
 *     carries `units` and is at least `floor`, or null
 *   upstreamFirst(net) → guids, each after the runs flowing into it
 */
import { FIXTURES } from './fixtures.js';

const NBR_BRANCH = { 40: 3, 50: 6, 75: 20, 100: 160 };
const NBR_MAIN_SLOPES = [0.005, 0.01, 0.02, 0.04];
const NBR_MAIN = { 100: [0, 180, 216, 250], 150: [0, 700, 840, 1000], 200: [1400, 1600, 1920, 2300] };
const IPC_BRANCH = { 1.5: 3, 2: 6, 2.5: 12, 3: 20, 4: 160, 5: 360, 6: 620, 8: 1400, 10: 2500, 12: 3900 };
const IPC_MAIN_SLOPES = [1 / 16 / 12, 1 / 8 / 12, 1 / 4 / 12, 1 / 2 / 12];
const IPC_MAIN = {
  1.25: [0, 0, 1, 1], 1.5: [0, 0, 3, 3], 2: [0, 0, 21, 26], 2.5: [0, 0, 24, 31], 3: [0, 36, 42, 50], 4: [0, 180, 216, 250], 5: [0, 390, 480, 575],
  6: [0, 700, 840, 1000], 8: [1400, 1600, 1920, 2300], 10: [2500, 2900, 3500, 4200], 12: [3900, 4600, 5600, 6700],
};
export const MAIN_MIN_DN = 100;   // NBR 8160: the building drain's smallest DN
export const DRAIN_TABLES = { br: { branch: NBR_BRANCH, main: NBR_MAIN, slopes: NBR_MAIN_SLOPES }, us: { branch: IPC_BRANCH, main: IPC_MAIN, slopes: IPC_MAIN_SLOPES } };

/** Fixture units a size carries: a branch from the branch table (else the main table), a building drain the other way round. */
export function capacity(std, nominal, slope, role = 'branch') {
  const T = DRAIN_TABLES[std];
  if (!T) return 0;
  const col = T.slopes.reduce((c, s, i) => (slope + 1e-9 >= s ? i : c), -1);
  const main = col >= 0 ? T.main[nominal]?.[col] || 0 : 0, branch = T.branch[nominal] || 0;
  return role === 'main' ? main || branch : branch || main;
}

export function smallestSize(std, sizes, units, { slope = 0, role = 'branch', floor = 0 } = {}) {
  for (const s of sizes) if (s.nominal + 1e-9 >= floor && capacity(std, s.nominal, slope, role) >= units) return s;
  return null;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Distance from p to a polyline. */
function offLine(verts, p) {
  let best = Infinity;
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i], d = sub(verts[i + 1], a), L2 = dot(d, d);
    const t = L2 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t, p[2] - a[2] - d[2] * t));
  }
  return best;
}

export function drainNetwork(runs, fixtures) {
  const tol = (r) => Math.max(5, (r.od || 0) / 2);
  const out = new Map(runs.map((r) => [r.guid, { uhc: 0, dfu: 0, minDn: 0, minIn: 0, up: [], down: null, fixtures: [] }]));
  // where each run flows: the other run its last point lies on (the nearest)
  for (const r of runs) {
    const end = r.verts[r.verts.length - 1];
    let best = null;
    for (const o of runs) {
      if (o === r) continue;
      const d = offLine(o.verts, end);
      if (d <= Math.max(tol(r), tol(o)) && (!best || d < best.d)) best = { o, d };
    }
    if (best) { out.get(r.guid).down = best.o.guid; out.get(best.o.guid).up.push(r.guid); }
  }
  // each fixture drains into the run passing through its connector
  const own = new Map(runs.map((r) => [r.guid, []]));
  for (const f of fixtures) {
    if (!FIXTURES[f.kind]) continue;
    let best = null;
    for (const r of runs) { const d = offLine(r.verts, f.p); if (d <= Math.max(tol(r), (f.size || 0) / 2) && (!best || d < best.d)) best = { r, d }; }
    if (best) own.get(best.r.guid).push(f);
  }
  // totals: a run's own fixtures and everything flowing into it (a loop is counted once)
  const done = new Set(), busy = new Set(), NONE = { uhc: 0, dfu: 0, minDn: 0, minIn: 0 };
  const total = (g) => {
    const n = out.get(g);
    if (busy.has(g)) return NONE;   // back round a loop: already being counted
    if (done.has(g)) return n;
    busy.add(g);
    for (const f of own.get(g)) { const k = FIXTURES[f.kind]; n.uhc += k.uhc; n.dfu += k.dfu; n.minDn = Math.max(n.minDn, k.dnMin); n.minIn = Math.max(n.minIn, k.trapIn); n.fixtures.push(f.id); }
    for (const u of n.up) { const m = total(u); n.uhc += m.uhc; n.dfu += m.dfu; n.minDn = Math.max(n.minDn, m.minDn); n.minIn = Math.max(n.minIn, m.minIn); }
    busy.delete(g); done.add(g);
    return n;
  };
  for (const r of runs) total(r.guid);
  return out;
}

export function upstreamFirst(net) {
  const order = [], seen = new Set();
  const visit = (g) => { if (seen.has(g)) return; seen.add(g); for (const u of net.get(g)?.up || []) visit(u); order.push(g); };
  for (const g of net.keys()) visit(g);
  return order;
}
