/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — node and port names are keys; the editor shows them through api.t ("node.<type>", "port.<key>"). */
/**
 * nodes.js — the visual script's nodes (graph.js runs them). No DOM: the Draw nodes reach the model only through
 * cx.draw(name, args), which the editor binds to api.draw.run (BimCraft add-on API 1.1) and the tests to a stand-in.
 * Units are BimCraft's: millimetres, degrees; points [x, y] in a level's plan.
 *
 *   input     number (a slider), point, text, toggle
 *   math      expression (expr.js, the family editor's formulas), series, range, item (one item of a list; negative counts from the end)
 *   geometry  rectangle, polygon, move, line points
 *   model     levels, walls, floor, door / window, grid, describe
 *   output    watch
 * An input with wire: false is typed in the node only; `choices` names the Draw tool and property whose enum lists them.
 */
import { compute } from '../../expr.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const r3 = (v) => Math.round(v * 1000) / 1000;
const pt = (p) => (Array.isArray(p) && p.length >= 2 ? [num(p[0]), num(p[1])] : [0, 0]);
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const refuse = (code) => { throw new Error(code); };

export const CATEGORIES = ['input', 'math', 'geometry', 'model', 'output'];

export const NODE_TYPES = [
  // ------------------------------------------------------------------ input
  {
    type: 'number', cat: 'input',
    inputs: [{ key: 'value', kind: 'number', default: 3000, wire: false, slider: true }, { key: 'min', kind: 'number', default: 0, wire: false }, { key: 'max', kind: 'number', default: 10000, wire: false }, { key: 'step', kind: 'number', default: 100, wire: false }],
    outputs: [{ key: 'value', kind: 'number' }],
    run: (i) => ({ value: num(i.value) }),
  },
  {
    type: 'point', cat: 'input',
    inputs: [{ key: 'x', kind: 'number', default: 0 }, { key: 'y', kind: 'number', default: 0 }],
    outputs: [{ key: 'point', kind: 'point' }],
    run: (i) => ({ point: [num(i.x), num(i.y)] }),
  },
  {
    type: 'text', cat: 'input',
    inputs: [{ key: 'value', kind: 'text', default: '', wire: false }],
    outputs: [{ key: 'value', kind: 'text' }],
    run: (i) => ({ value: String(i.value ?? '') }),
  },
  {
    type: 'toggle', cat: 'input',
    inputs: [{ key: 'value', kind: 'bool', default: true, wire: false }],
    outputs: [{ key: 'value', kind: 'bool' }],
    run: (i) => ({ value: !!i.value }),
  },
  // ------------------------------------------------------------------ math
  {
    type: 'expression', cat: 'math',
    inputs: [{ key: 'formula', kind: 'text', default: 'a + b', wire: false }, { key: 'a', kind: 'number', default: 0 }, { key: 'b', kind: 'number', default: 0 }, { key: 'c', kind: 'number', default: 0 }],
    outputs: [{ key: 'value', kind: 'number' }],
    run: (i) => {
      const r = compute(String(i.formula || ''), { a: num(i.a), b: num(i.b), c: num(i.c) });
      if (!r.ok) throw new Error(r.error || 'formula');
      return { value: r.value };
    },
  },
  {
    type: 'series', cat: 'math',
    inputs: [{ key: 'start', kind: 'number', default: 0 }, { key: 'step', kind: 'number', default: 1000 }, { key: 'count', kind: 'number', default: 5 }],
    outputs: [{ key: 'list', kind: 'numbers' }],
    run: (i) => {
      const n = Math.floor(num(i.count));
      if (!(n >= 0 && n <= 1000)) refuse('count');
      return { list: Array.from({ length: n }, (_, k) => r3(num(i.start) + k * num(i.step))) };
    },
  },
  {
    type: 'range', cat: 'math',
    inputs: [{ key: 'from', kind: 'number', default: 0 }, { key: 'to', kind: 'number', default: 10000 }, { key: 'count', kind: 'number', default: 5 }],
    outputs: [{ key: 'list', kind: 'numbers' }],
    run: (i) => {
      const n = Math.floor(num(i.count));
      if (!(n >= 1 && n <= 1000)) refuse('count');
      const a = num(i.from), b = num(i.to);
      return { list: n === 1 ? [a] : Array.from({ length: n }, (_, k) => r3(a + ((b - a) * k) / (n - 1))) };
    },
  },
  {
    type: 'item', cat: 'math',
    inputs: [{ key: 'list', kind: 'any', default: [] }, { key: 'index', kind: 'number', default: 0 }],
    outputs: [{ key: 'item', kind: 'any' }, { key: 'count', kind: 'number' }],
    run: (i) => {
      const a = list(i.list), k = Math.floor(num(i.index));
      return { item: a.length ? a[((k % a.length) + a.length) % a.length] : null, count: a.length };
    },
  },
  // ------------------------------------------------------------------ geometry
  {
    type: 'rectangle', cat: 'geometry',
    inputs: [{ key: 'origin', kind: 'point', default: [0, 0] }, { key: 'width', kind: 'number', default: 6000 }, { key: 'depth', kind: 'number', default: 4000 }],
    outputs: [{ key: 'points', kind: 'points' }],
    run: (i) => {
      const [x, y] = pt(i.origin), w = num(i.width), d = num(i.depth);
      if (!(w > 0 && d > 0)) refuse('size');
      return { points: [[x, y], [x + w, y], [x + w, y + d], [x, y + d]].map((p) => p.map(r3)) };
    },
  },
  {
    type: 'polygon', cat: 'geometry',
    inputs: [{ key: 'center', kind: 'point', default: [0, 0] }, { key: 'radius', kind: 'number', default: 4000 }, { key: 'sides', kind: 'number', default: 6 }, { key: 'angle', kind: 'number', default: 0 }],
    outputs: [{ key: 'points', kind: 'points' }],
    run: (i) => {
      const [x, y] = pt(i.center), r = num(i.radius), n = Math.floor(num(i.sides)), a0 = (num(i.angle) * Math.PI) / 180;
      if (!(r > 0) || !(n >= 3 && n <= 200)) refuse('size');
      return { points: Array.from({ length: n }, (_, k) => { const a = a0 + (2 * Math.PI * k) / n; return [r3(x + r * Math.cos(a)), r3(y + r * Math.sin(a))]; }) };
    },
  },
  {
    type: 'move', cat: 'geometry',
    inputs: [{ key: 'points', kind: 'points', default: [] }, { key: 'dx', kind: 'number', default: 0 }, { key: 'dy', kind: 'number', default: 0 }],
    outputs: [{ key: 'points', kind: 'points' }],
    run: (i) => ({ points: list(i.points).map((p) => { const [x, y] = pt(p); return [r3(x + num(i.dx)), r3(y + num(i.dy))]; }) }),
  },
  {
    type: 'line', cat: 'geometry',
    inputs: [{ key: 'start', kind: 'point', default: [0, 0] }, { key: 'end', kind: 'point', default: [6000, 0] }],
    outputs: [{ key: 'points', kind: 'points' }, { key: 'length', kind: 'number' }],
    run: (i) => { const a = pt(i.start), b = pt(i.end); return { points: [a, b], length: r3(Math.hypot(b[0] - a[0], b[1] - a[1])) }; },
  },
  // ------------------------------------------------------------------ model (BimCraft's Draw edits, one undo step each)
  {
    type: 'levels', cat: 'model', draws: true,
    inputs: [{ key: 'count', kind: 'number', default: 3 }, { key: 'height', kind: 'number', default: 3000 }],
    outputs: [{ key: 'names', kind: 'texts' }],
    run: async (i, cx) => {
      const n = Math.floor(num(i.count)), h = num(i.height);
      if (!(n >= 1 && n <= 100) || !(h >= 1000)) refuse('size');
      const r = await cx.draw('levels_add', { elevations: Array.from({ length: n }, (_, k) => k * h) });
      return { names: (r.levels || []).map((l) => l.name) };
    },
  },
  {
    type: 'walls', cat: 'model', draws: true,
    inputs: [{ key: 'points', kind: 'points', default: [] }, { key: 'level', kind: 'text', default: '' }, { key: 'closed', kind: 'bool', default: true }, { key: 'type', kind: 'choice', default: 'ext-2x6', choices: ['walls_add', 'type'] }, { key: 'height', kind: 'number', default: 0 }],
    outputs: [{ key: 'walls', kind: 'guids' }],
    run: async (i, cx) => {
      const pts = list(i.points).map(pt);
      if (pts.length < 2) refuse('points');
      const a = { points: pts, closed: !!i.closed && pts.length >= 3, type: String(i.type || 'ext-2x6') };
      if (i.level) a.level = String(i.level);
      if (num(i.height) > 0) a.height = num(i.height);
      return { walls: (await cx.draw('walls_add', a)).walls || [] };
    },
  },
  {
    type: 'floor', cat: 'model', draws: true,
    inputs: [{ key: 'points', kind: 'points', default: [] }, { key: 'level', kind: 'text', default: '' }, { key: 'kind', kind: 'choice', default: 'concrete', choices: ['floor_add', 'kind'] }, { key: 'thickness', kind: 'number', default: 0 }],
    outputs: [{ key: 'floor', kind: 'guid' }],
    run: async (i, cx) => {
      const pts = list(i.points).map(pt);
      if (pts.length < 3) refuse('points');
      const a = { points: pts, kind: String(i.kind || 'concrete') };
      if (i.level) a.level = String(i.level);
      if (num(i.thickness) > 0) a.thickness = num(i.thickness);
      return { floor: (await cx.draw('floor_add', a)).floor || null };
    },
  },
  {
    type: 'opening', cat: 'model', draws: true,
    inputs: [{ key: 'wall', kind: 'guid', default: '' }, { key: 'kind', kind: 'choice', default: 'door', choices: ['opening_add', 'kind'] }, { key: 'offset', kind: 'number', default: -1 }, { key: 'width', kind: 'number', default: 0 }],
    outputs: [{ key: 'opening', kind: 'guid' }],
    run: async (i, cx) => {
      if (!i.wall) refuse('wall');
      const a = { wall: String(i.wall), kind: i.kind === 'window' ? 'window' : 'door' };
      if (num(i.offset) >= 0) a.offset = num(i.offset);
      if (num(i.width) > 0) a.width = num(i.width);
      const r = await cx.draw('opening_add', a);
      return { opening: r[a.kind] || null };
    },
  },
  {
    type: 'grid', cat: 'model', draws: true,
    inputs: [{ key: 'origin', kind: 'point', default: [0, 0] }, { key: 'ucount', kind: 'number', default: 4 }, { key: 'uspacing', kind: 'number', default: 6000 }, { key: 'vcount', kind: 'number', default: 3 }, { key: 'vspacing', kind: 'number', default: 6000 }, { key: 'level', kind: 'text', default: '' }],
    outputs: [{ key: 'tags', kind: 'texts' }],
    run: async (i, cx) => {
      const a = { origin: pt(i.origin), u: { count: Math.floor(num(i.ucount)), spacing: num(i.uspacing) }, v: { count: Math.floor(num(i.vcount)), spacing: num(i.vspacing) } };
      if (i.level) a.level = String(i.level);
      return { tags: (await cx.draw('grid_add', a)).lines || [] };
    },
  },
  {
    type: 'describe', cat: 'model',
    inputs: [{ key: 'after', kind: 'any', default: null }],
    outputs: [{ key: 'levels', kind: 'texts' }, { key: 'walls', kind: 'number' }, { key: 'rooms', kind: 'numbers' }],
    run: async (i, cx) => {
      const r = await cx.draw('model_describe', {});
      return { levels: (r.levels || []).map((l) => l.name), walls: r.walls?.count ?? 0, rooms: (r.rooms || []).map((x) => x.area) };
    },
  },
  // ------------------------------------------------------------------ output
  {
    type: 'watch', cat: 'output',
    inputs: [{ key: 'value', kind: 'any', default: null }],
    outputs: [{ key: 'value', kind: 'any' }],
    run: (i) => ({ value: i.value ?? null }),
  },
];

/** The demo graph: a slider-sized room (walls closed round a rectangle) with a floor under it and a door in its first wall. */
export function exampleGraph() {
  return {
    format: 'bimcraft-visual-script', version: 1,
    nodes: [
      { id: 'n1', type: 'number', x: 20, y: 20, v: { value: 6000, min: 2000, max: 15000, step: 100 } },
      { id: 'n2', type: 'number', x: 20, y: 260, v: { value: 4000, min: 2000, max: 15000, step: 100 } },
      { id: 'n3', type: 'rectangle', x: 270, y: 120, v: {} },
      { id: 'n4', type: 'walls', x: 500, y: 20, v: { closed: true, type: 'ext-2x6' } },
      { id: 'n5', type: 'floor', x: 500, y: 360, v: { kind: 'concrete' } },
      { id: 'n9', type: 'item', x: 740, y: 20, v: { index: 0 } },
      { id: 'n6', type: 'opening', x: 980, y: 20, v: { kind: 'door' } },
      { id: 'n7', type: 'describe', x: 980, y: 300, v: {} },
      { id: 'n8', type: 'watch', x: 1220, y: 300, v: {} },
    ],
    links: [
      { from: 'n1', out: 'value', to: 'n3', in: 'width' },
      { from: 'n2', out: 'value', to: 'n3', in: 'depth' },
      { from: 'n3', out: 'points', to: 'n4', in: 'points' },
      { from: 'n3', out: 'points', to: 'n5', in: 'points' },
      { from: 'n4', out: 'walls', to: 'n9', in: 'list' },
      { from: 'n9', out: 'item', to: 'n6', in: 'wall' },
      { from: 'n6', out: 'opening', to: 'n7', in: 'after' },
      { from: 'n7', out: 'rooms', to: 'n8', in: 'value' },
    ],
  };
}
