/* SPDX-License-Identifier: Apache-2.0 */
/**
 * assets-bim-sensors-ui.js — sensor readings in BimCraft's Assets tab (0.7 LC.12 items 3–4, session bim-ops): open a CSV of
 * readings (time + one column per asset tag), see each asset's latest reading in the list and on the model (colour by value,
 * a label), a small chart per asset, and limits that flag it. Readings stay in this session; limits are written into the IFC
 * (assets-bim-sensors.js sensorOp). Live feeds (assets-bim-live-ui.js) push into the same store.
 *
 *   SENSORS — the one store and its view state for the open page: { store, show, file, unmatched, matched, bad }
 *   sensorSection(host, ctx) → element   the Sensor values section (open a CSV, show on the model, legend, clear)
 *   readingCell(a) → element | null       the list's reading cell
 *   sensorDetail(a, host, ctx) → [elements]   an asset's latest reading, its limits (saved in the IFC), its chart
 *   paintModel(host, assets)              colours + labels on the model while "Show on the model" is on; off: cleared
 *   ctx = { assets() → readAssets list, commit(op, label) → bool, render() }
 * Lowest tier (rule 19): at most LABELS labels on the model; charts off on a phone (a button shows one).
 */
import { el } from './ui-util.js';
import { t } from './i18n.js';
import { SensorStore, parseSensorCsv, matchSensors, flagOf, colorOf, chartPath, sensorOp, COLORS } from './assets-bim-sensors.js';

export const LABELS = 60;
export const SENSORS = { store: new SensorStore(), show: false, file: '', unmatched: [], matched: 0, bad: null, open: false, chartsOnPhone: new Set() };
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); n.append(...kids.filter(Boolean)); return n; };
const isPhone = () => document.documentElement.classList.contains('cc-phone') || (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches);   // i18n-ignore: a media query
const fmt = (v) => (Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : String(Math.round(v * 100) / 100));
const when = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

/** Read a CSV of readings into the store (replacing the series it names). → a status text. */
export async function openSensorCsv(file, assets) {
  if (file.size > 50 * 1024 * 1024) throw Object.assign(new Error('big'), { key: 'assets.sensor.err.too-big' });
  const p = parseSensorCsv(await file.text());
  const m = matchSensors(p.cols.map((c) => c.head), assets);
  let matched = 0;
  for (const c of p.cols) { const a = m.byHead.get(c.head); if (a) { SENSORS.store.set(a.guid, p.times, c.values); matched++; } }
  Object.assign(SENSORS, { file: file.name, unmatched: m.unmatched, matched, bad: p.bad });
  return { matched, rows: p.rows, unmatched: m.unmatched.length, bad: p.bad };
}

export function sensorSection(host, ctx) {
  const S = SENSORS, has = S.store.guids().length > 0;
  return el('details', { className: 'as-cobie', 'data-as-sensors': '', open: S.open || has, ontoggle: (ev) => { S.open = ev.target.open; } },
    el('summary', {}, t('assets.sensor.h')),
    el('p', { className: 'bc-muted' }, t('assets.sensor.intro')),
    el('div', { className: 'fa-head' },
      el('label', { className: 'btn-line btn-sm-cc' }, t('assets.sensor.btn.open'),
        el('input', { type: 'file', accept: '.csv,.txt,text/csv', hidden: true, 'data-as-sensor-file': '', onchange: async (ev) => {
          const f = ev.target.files?.[0]; ev.target.value = '';
          if (!f) return;
          try {
            const r = await openSensorCsv(f, ctx.assets());
            host.status(t('assets.sensor.opened', { n: r.matched, rows: r.rows }), !r.matched);
          } catch (err) { host.status(err.key ? t(err.key) : t('assets.sensor.err.read', { why: String(err.message || err) }), true); }
          ctx.render();
        } })),
      has ? el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-as-sensor-clear': '', onclick: () => { S.store.clear(); S.file = ''; S.unmatched = []; S.matched = 0; S.bad = null; paintModel(host, []); ctx.render(); } }, t('assets.sensor.btn.clear')) : null),
    S.file ? el('p', { className: 'bc-muted', 'data-as-sensor-summary': '' }, t('assets.sensor.summary', { file: S.file, n: S.matched })) : null,
    S.unmatched.length ? el('p', { className: 'bc-muted fa-warn', 'data-as-sensor-unmatched': '' }, t('assets.sensor.unmatched', { n: S.unmatched.length, names: S.unmatched.slice(0, 6).join(', ') })) : null,
    S.bad && (S.bad.time || S.bad.value) ? el('p', { className: 'bc-muted' }, t('assets.sensor.bad', { n: S.bad.time + S.bad.value })) : null,
    has ? el('label', { className: 'fa-check' }, el('input', { type: 'checkbox', checked: S.show, 'data-as-sensor-show': '', onchange: (ev) => { S.show = ev.target.checked; paintModel(host, ctx.assets()); } }), t('assets.sensor.show')) : null,
    has ? el('p', { className: 'bc-muted as-legend', 'data-as-sensor-legend': '' },
      ...[['low', COLORS.low], ['ok', COLORS.ok], ['high', COLORS.high]].map(([k, c]) => legendKey([swatch(c)], t('assets.sensor.key.' + k))),
      legendKey([swatch(COLORS.ramp[0]), swatch(COLORS.ramp[4])], t('assets.sensor.key.ramp'))) : null,
    el('p', { className: 'bc-muted' }, t('assets.sensor.session')));
}
/** One legend entry on its own line (styles set through the DOM: BimCraft's stylesheet is mep-07's file). */
function legendKey(sw, text) { const k = el('span', { className: 'as-key' }, ...sw, text); k.style.display = 'block'; return k; }
function swatch(c) { const s = el('span', { className: 'as-swatch', 'aria-hidden': 'true' }); s.style.background = c; s.style.display = 'inline-block'; s.style.width = '.75rem'; s.style.height = '.75rem'; s.style.marginRight = '.25rem'; s.style.verticalAlign = '-.1rem'; s.style.border = '1px solid currentColor'; return s; }

export function readingCell(a) {
  const r = SENSORS.store.latest(a.guid);
  if (!r) return el('td', { className: 'bc-muted' }, '');
  const f = flagOf(r.v, a.limits);
  return el('td', { 'data-as-reading': a.guid }, fmt(r.v), a.limits.unit ? ' ' + a.limits.unit : '',
    f ? el('span', { className: 'as-badge-line' }, el('span', { className: 'as-due as-overdue', 'data-as-flag': f }, t('assets.sensor.flag.' + f))) : null);
}

export function sensorDetail(a, host, ctx) {
  const out = [el('h3', { className: 'bc-h fa-h3' }, t('assets.sensor.h.asset'))];
  const r = SENSORS.store.latest(a.guid), f = r ? flagOf(r.v, a.limits) : '';
  out.push(r ? el('p', { 'data-as-sensor-latest': '' }, el('strong', {}, fmt(r.v) + (a.limits.unit ? ' ' + a.limits.unit : '')), ' ', t('assets.sensor.at', { when: when(r.t) }),
    f ? el('span', { className: 'as-due as-overdue', 'data-as-flag': f }, ' ' + t('assets.sensor.flag.' + f)) : null)
    : el('p', { className: 'bc-muted' }, t('assets.sensor.none')));
  const L = { low: a.limits.low ?? '', high: a.limits.high ?? '', unit: a.limits.unit || '' };
  const box = (k, type) => el('label', { className: 'fa-field' }, el('span', {}, t('assets.sensor.f.' + k)),
    el('input', { type, step: type === 'number' ? 'any' : undefined, className: 'bc-input fa-input', value: String(L[k]), 'data-as-limit': k, oninput: (ev) => { L[k] = ev.target.value; } }));
  out.push(el('div', { className: 'as-form' }, box('low', 'number'), box('high', 'number'), box('unit', 'text')),
    el('div', { className: 'fa-head' }, el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-as-limit-save': '', onclick: () => {
      try { if (ctx.commit(sensorOp(a.guid, L), a.name || a.guid)) host.status(t('assets.sensor.saved')); } catch (err) { host.status(err.key ? t(err.key) : String(err.message || err), true); }
    } }, t('assets.sensor.btn.limits'))));
  const s = SENSORS.store.series(a.guid);
  if (s && s.times.length) {
    if (isPhone() && !SENSORS.chartsOnPhone.has(a.guid)) out.push(el('p', { className: 'bc-muted' }, t('assets.sensor.chart-off'), ' ', el('button', { type: 'button', className: 'bc-linkbtn', 'data-as-chart-show': '', onclick: () => { SENSORS.chartsOnPhone.add(a.guid); ctx.render(); } }, t('assets.sensor.btn.chart'))));
    else out.push(chart(s, a.limits));
  }
  return out;
}

function chart(s, limits) {
  const W = 280, H = 90, c = chartPath(s.times, s.values, W, H, { limits });
  const ink = 'currentColor';
  const g = svg('svg', { viewBox: `-2 -2 ${W + 4} ${H + 4}`, width: '100%', role: 'img', 'aria-label': t('assets.sensor.chart', { n: c.n, min: fmt(c.min), max: fmt(c.max) }), 'data-as-chart': '', class: 'as-chart' },
    svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'none', stroke: ink, 'stroke-opacity': '.25', 'vector-effect': 'non-scaling-stroke' }),
    ...c.lines.map((l) => svg('line', { x1: 0, x2: W, y1: l.y, y2: l.y, stroke: l.kind === 'high' ? COLORS.high : COLORS.low, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' })),
    svg('path', { d: c.d, fill: 'none', stroke: ink, 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
  return el('figure', { className: 'as-figure' }, g,
    el('figcaption', { className: 'bc-muted' }, t('assets.sensor.range', { min: fmt(c.min), max: fmt(c.max), from: when(c.t0), to: when(c.t1), n: c.n })));
}

// ---------------------------------------------------------------- on the model
let overlay = null, centres = new Map(), chained = null;
export function paintModel(host, assets) {
  const v = host.viewer?.();
  if (!v) return;
  if (!SENSORS.show) {
    if (overlay) { overlay.remove(); overlay = null; }
    if (chained) { v.onRender = chained.prev; chained = null; }
    if (paintModel.painted) { v.setColors(null); paintModel.painted = false; }
    return;
  }
  const items = [];
  const latest = assets.map((a) => ({ a, r: SENSORS.store.latest(a.guid) })).filter((x) => x.r);
  const vals = latest.map((x) => x.r.v);
  const scale0 = { min: Math.min(...vals), max: Math.max(...vals) };
  const colors = new Map();
  for (const { a, r } of latest) {
    const limited = a.limits.low !== null || a.limits.high !== null;
    colors.set(a.id, colorOf(r.v, limited ? a.limits : scale0));
    items.push({ key: a.id, text: fmt(r.v) + (a.limits.unit ? ' ' + a.limits.unit : ''), flag: flagOf(r.v, a.limits) });
  }
  v.setColors(colors.size ? colors : null);
  paintModel.painted = colors.size > 0;
  // labels: flagged first, at most LABELS
  items.sort((x, y) => (y.flag ? 1 : 0) - (x.flag ? 1 : 0));
  const host2 = v.canvas.parentElement;
  if (!overlay) {
    overlay = el('div', { className: 'as-labels', 'data-as-labels': '', 'aria-hidden': 'true' });
    Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    if (getComputedStyle(host2).position === 'static') host2.style.position = 'relative';
    host2.append(overlay);
  }
  centres = new Map();
  overlay.replaceChildren(...items.slice(0, LABELS).map((it) => {
    const bb = v.keyBounds([it.key]);
    if (bb) centres.set(it.key, [(bb.min[0] + bb.max[0]) / 2, bb.max[1], (bb.min[2] + bb.max[2]) / 2]);   // the viewer is Y-up: over the element's top
    const n = el('span', { 'data-as-label': String(it.key), 'data-flag': it.flag }, it.text);
    Object.assign(n.style, { position: 'absolute', left: '0', top: '0', padding: '0 .25rem', font: '600 .75rem/1.3 system-ui, sans-serif', whiteSpace: 'nowrap',   // i18n-ignore: CSS
      background: 'var(--sheet, #fff)', color: it.flag ? COLORS.high : 'var(--ink, #111)', border: '1px solid currentColor', borderRadius: '2px' });
    return n;
  }));
  if (!chained) { chained = { prev: v.onRender }; v.onRender = () => { chained?.prev?.(); place(v); }; }
  place(v);
  v.render();
}
function place(v) {
  if (!overlay) return;
  const r = v.canvas.getBoundingClientRect(), pr = overlay.getBoundingClientRect();
  for (const n of overlay.children) {
    const c = centres.get(Number(n.dataset.asLabel)), p = c ? v.project(c) : null;
    if (!p || p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) { n.style.display = 'none'; continue; }
    n.style.display = '';
    n.style.transform = `translate(${Math.round(p.x - pr.left)}px, ${Math.round(p.y - pr.top)}px) translate(-50%, -120%)`;
  }
}
