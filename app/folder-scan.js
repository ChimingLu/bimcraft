/* SPDX-License-Identifier: Apache-2.0 */
/**
 * folder-scan.js — makes sense of a project folder the way a person would, reading only what
 * it needs (rvt-reader.js reads Revit files by byte range). No DOM: bin/test-bimcraft.mjs
 * runs it in Node.
 *
 *   models       .rvt/.rfa/.rte/.rft grouped with their numbered backups ("Tower.0004.rvt"
 *                belongs to "Tower.rvt"); the newest readable copy is read for the card; every
 *                copy gets a header-only health check, so a cut-off file is flagged
 *   links        each model's linked/referenced files resolved against the folder: by relative
 *                path, then by the tail of an absolute path (\\server\…\Cad\X-Refs\a.dwg finds
 *                X-Refs/a.dwg), then by file name; Revit library tables (keynotes, assembly
 *                codes) live on each computer and are labelled so, not "missing"
 *   cad / ifc    DWG/DXF/DGN drawings (with which models link them) and IFC models
 *   focus        the model a person would most likely open to work on, with plain reasons;
 *                every other model gets a role (backups only, linked by…, central, starter, family)
 *   housekeeping Revit's own folders (<name>_backup, <name>_log, Revit_temp) — not read
 *   leftovers    .dwl/.dwl2/.bak/.err/.log and similar lock/temp files
 *
 *   const scan = await scanFolder({ name, files: [{ path, file }], skipped: [dirPath] }, { onProgress });
 * `path` is relative to the picked folder with "/" separators; `file` is a File/Blob.
 */
import { readRevit, checkCompoundFile } from './rvt-reader.js';
import { t } from "./i18n.js";

export const HOUSEKEEPING_DIR = /(_backup|_log)$|^revit_temp$|^\.|^__macosx$/i;
const MODEL_EXT = new Set(['rvt', 'rfa', 'rte', 'rft']);
const CAD_EXT = new Set(['dwg', 'dxf', 'dgn']);
/** 0.7 BIM-BUNDLE-OPEN: a project bundle is known by its name (…ccbundle.zip or …ccbundle); a plain .zip stays among the other files. */
export const isBundleName = (name) => /\.ccbundle(\.zip)?$/i.test(name);
const LEFTOVER_EXT = new Set(['dwl', 'dwl2', 'bak', 'err', 'log', 'tmp', 'sv$', 'ac$', 'lck', 'slog']);
const LIBRARY_TYPES = /keynote|assembly code/i;
const BACKUP_RE = /^(.*)\.(\d{4})$/;

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const dirOf = (path) => { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(0, i) : ''; };
const baseOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/** "a/b/../c" → "a/c"; returns null when the path climbs above the picked folder. */
export function normalizePath(p) {
  const out = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

export function isHousekeepingPath(path) {
  return dirOf(path).split('/').some((seg) => seg && HOUSEKEEPING_DIR.test(seg));
}

/** Index of the folder's files for link lookups (case-insensitive, like Windows). */
export function indexFiles(files) {
  const byPath = new Map(), byName = new Map();
  for (const f of files) {
    byPath.set(f.path.toLowerCase(), f);
    const n = baseOf(f.path).toLowerCase();
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f);
  }
  return { byPath, byName };
}

/**
 * Where a model's reference points inside the folder.
 * @returns {status: 'found'|'found_by_name'|'library'|'missing', match: ?file, how: string}
 */
export function resolveLink(ref, modelDir, index) {
  const raw = (ref.path || ref.absolute || '').trim();
  const tries = [ref.path, ref.absolute].filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  for (const p of tries) {
    const absolute = /^([a-z]:\/|\/\/|\/)/i.test(p);
    if (!absolute) {
      const joined = normalizePath((modelDir ? modelDir + '/' : '') + p);
      const hit = joined && index.byPath.get(joined.toLowerCase());
      if (hit) return { status: 'found', match: hit, how: 'path' };
    }
    // Tail of the path: \\server\share\Project\Cad\X-Refs\a.dwg → X-Refs/a.dwg in a picked "Cad".
    const segs = normalizePath(p.replace(/^[a-z]:\//i, '').replace(/^\/+/, '')) || '';
    const parts = segs.split('/').filter(Boolean);
    for (let k = 1; k < parts.length; k++) {
      const hit = index.byPath.get(parts.slice(k).join('/').toLowerCase());
      if (hit) return { status: 'found', match: hit, how: 'path' };
    }
  }
  const name = baseOf(raw.replace(/\\/g, '/')).toLowerCase();
  const same = name ? index.byName.get(name) : null;
  if (same && same.length) {
    const near = same.find((f) => dirOf(f.path).toLowerCase() === (modelDir || '').toLowerCase()) || [...same].sort((a, b) => a.path.length - b.path.length)[0];
    return { status: 'found_by_name', match: near, how: 'name' };
  }
  if (LIBRARY_TYPES.test(ref.type || '')) return { status: 'library', match: null, how: '' };
  return { status: 'missing', match: null, how: '' };
}

/** Group model files with their numbered backups. */
export function groupModels(files) {
  const groups = new Map();
  for (const f of files) {
    const ext = extOf(f.path);
    if (!MODEL_EXT.has(ext)) continue;
    const name = baseOf(f.path);
    const stem = name.slice(0, -(ext.length + 1));
    const m = BACKUP_RE.exec(stem);
    const base = m ? m[1] : stem;
    const key = (dirOf(f.path) + '/' + base + '.' + ext).toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, dir: dirOf(f.path), name: base + '.' + ext, ext, main: null, backups: [] });
    const g = groups.get(key);
    if (m) g.backups.push({ entry: f, num: m[2] });
    else g.main = { entry: f };
  }
  for (const g of groups.values()) g.backups.sort((a, b) => b.num.localeCompare(a.num));
  return [...groups.values()].sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

export async function scanFolder({ name, files, skipped = [] }, { onProgress = () => {}, concurrency = 3 } = {}) {
  const live = [], housekeeping = new Map(), leftovers = [], cad = [], ifc = [], bundles = [], other = [];
  for (const d of skipped) housekeeping.set(d, housekeeping.get(d) || 0);
  for (const f of files) {
    if (isHousekeepingPath(f.path)) {
      const segs = dirOf(f.path).split('/');
      const hk = segs.slice(0, segs.findIndex((s) => HOUSEKEEPING_DIR.test(s)) + 1).join('/');   // the housekeeping folder itself
      housekeeping.set(hk, (housekeeping.get(hk) || 0) + 1);
      continue;
    }
    live.push(f);
    const ext = extOf(f.path);
    if (LEFTOVER_EXT.has(ext)) leftovers.push(f);
    else if (isBundleName(f.path)) bundles.push(f);
    else if (CAD_EXT.has(ext)) cad.push(f);
    else if (ext === 'ifc') ifc.push(f);
    else if (!MODEL_EXT.has(ext)) other.push(f);
  }

  const groups = groupModels(live);
  const index = indexFiles(live);
  const copies = groups.reduce((n, g) => n + (g.main ? 1 : 0) + g.backups.length, 0);
  let done = 0;
  const tick = (label) => onProgress({ done: ++done, total: copies, label });

  await pool(groups, concurrency, async (g) => {
    // Every copy: header-only health check (512 bytes each).
    const all = [...(g.main ? [g.main] : []), ...g.backups];
    for (const c of all) {
      const h = await checkCompoundFile(c.entry.file).catch((e) => ({ ok: false, code: 'error', message: e.message }));
      c.status = h.ok ? 'ok' : (h.code === 'truncated' ? 'truncated' : 'error');
      c.message = h.ok ? '' : h.message;
      c.expectedAtLeast = h.expectedAtLeast || null;
      tick(c.entry.path);
    }
    // The card: the main file if it is sound, else the newest sound backup.
    g.best = all.find((c) => c.status === 'ok') || null;
    if (g.best) {
      try {
        g.info = await readRevit(g.best.entry.file, baseOf(g.best.entry.path));
      } catch (e) {
        g.best.status = e.code === 'truncated' ? 'truncated' : 'error';
        g.best.message = e.message;
        g.info = null;
      }
    }
    g.links = (g.info?.references || [])
      .filter((r) => r.path || r.absolute)
      .map((r) => ({ ...r, ...resolveLink(r, g.dir, index) }));
  });

  const focus = pickFocus(groups);

  // Links across the folder, and which models use each drawing.
  const linkMap = new Map();
  const usedBy = new Map();
  for (const g of groups) {
    for (const l of g.links || []) {
      const k = l.match ? 'f:' + l.match.path.toLowerCase() : 'r:' + (l.path || l.absolute).toLowerCase();
      if (!linkMap.has(k)) linkMap.set(k, { type: l.type, ref: l.path || l.absolute, status: l.status, match: l.match, how: l.how, usedBy: [] });
      const row = linkMap.get(k);
      if (!row.usedBy.includes(g.name)) row.usedBy.push(g.name);
      if (l.match) {
        const p = l.match.path.toLowerCase();
        if (!usedBy.has(p)) usedBy.set(p, new Set());
        usedBy.get(p).add(g.name);
      }
    }
  }
  const order = { missing: 0, found_by_name: 1, found: 2, library: 3 };
  const links = [...linkMap.values()].sort((a, b) => order[a.status] - order[b.status] || a.ref.localeCompare(b.ref));

  const totalSize = files.reduce((n, f) => n + (f.file.size || 0), 0);
  return {
    name,
    index,               // for resolving links of any model opened from this folder
    files: files.length,
    totalSize,
    models: groups,
    links,
    cad: cad.map((f) => ({ ...f, usedBy: [...(usedBy.get(f.path.toLowerCase()) || [])] })).sort((a, b) => a.path.localeCompare(b.path)),
    ifc: ifc.sort((a, b) => a.path.localeCompare(b.path)),
    bundles: bundles.sort((a, b) => a.path.localeCompare(b.path)),   // 0.7 BIM-BUNDLE-OPEN
    housekeeping: [...housekeeping.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    leftovers,
    other,
    focus,               // { group, reasons[] } — the file a person would most likely open to work on, or null
    problems: groups.reduce((n, g) => n + [g.main, ...g.backups].filter((c) => c && c.status !== 'ok').length, 0),
  };
}

const STARTER = /^(blank|template|default|project\d*$|untitled)/i;
const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * Give every model a role and pick the one to start with. A best guess from names, dates and
 * links, the same reasoning an experienced user applies:
 *   linked    another model in the folder links it → someone else's background (e.g. the architect's)
 *   starter   Blank…/Template…/Project1 → a starting point or never properly named
 *   central   a workshared central → you would open a local copy, not this
 *   family    .rfa/.rft → a part, not the project
 *   backups   only numbered backups survive (no main file)
 * Candidates: readable project files (.rvt/.rte), not linked, not starters. Centrals and
 * backup-only models count only if nothing better exists. Newest saved work wins.
 */
export function pickFocus(groups) {
  const byPath = new Map();
  for (const g of groups) for (const c of [g.main, ...g.backups]) if (c) byPath.set(c.entry.path.toLowerCase(), g);
  for (const g of groups) g.linkedBy = [];
  for (const g of groups) {
    for (const l of g.links || []) {
      const target = l.match && byPath.get(l.match.path.toLowerCase());
      if (target && target !== g && !target.linkedBy.includes(g.name)) target.linkedBy.push(g.name);
    }
  }
  for (const g of groups) {
    const stem = g.name.replace(/\.[^.]+$/, '');
    const ws = g.info?.basic?.worksharing || '';
    g.roles = [];
    if (g.linkedBy.length) g.roles.push('linked');
    if (STARTER.test(stem)) g.roles.push('starter');
    if (/central/i.test(stem) || /central/i.test(ws)) g.roles.push('central');
    if (g.ext === 'rfa' || g.ext === 'rft') g.roles.push('family');
    if (!g.main) g.roles.push('backups');
    g.when = g.best ? g.best.entry.file.lastModified || 0 : 0;
  }
  const project = groups.filter((g) => g.best && g.info && (g.ext === 'rvt' || g.ext === 'rte') && !g.roles.includes('linked') && !g.roles.includes('starter'));
  const tiers = [
    project.filter((g) => !g.roles.includes('central') && !g.roles.includes('backups')),
    project.filter((g) => !g.roles.includes('central')),
    project,
  ];
  const pool = tiers.find((t) => t.length);
  if (!pool) return null;
  const pick = [...pool].sort((a, b) => b.when - a.when || (b.best.entry.file.size - a.best.entry.file.size))[0];

  const reasons = [];
  reasons.push(pick.when ? t('folder.why.newest.date', { date: fmtDay(pick.when) }) : t('folder.why.newest'));
  if (pick.roles.includes('backups')) reasons.push(t('folder.why.backups'));
  if (pick.main && pick.main !== pick.best) reasons.push(t('folder.why.damaged'));
  // A damaged "obvious" sibling with an older last good copy (e.g. "- 2014.rvt" beside "- 2014_KA.rvt").
  const pickStem = pick.name.replace(/\.[^.]+$/, '').toLowerCase();
  for (const g of groups) {
    if (g === pick || !g.main || g.main.status === 'ok') continue;
    const stem = g.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (pickStem.startsWith(stem) || stem.startsWith(pickStem)) {
      reasons.push(g.best && g.when ? t('folder.why.sibling.date', { name: g.name, date: fmtDay(g.when) }) : t('folder.why.sibling', { name: g.name }));
    }
  }
  const background = groups.filter((g) => g.roles.includes('linked'));
  if (background.length) reasons.push(t('folder.why.linked', { n: background.length, names: background.map((g) => g.name).join(', ') }));
  if (pick.roles.includes('central')) reasons.push(t('folder.why.central'));
  return { group: pick, reasons };
}
