/* SPDX-License-Identifier: Apache-2.0 */
/**
 * folder-view.js — draws a folder-scan.js result: what's in the folder, model by model, which
 * linked files are there, and what was set aside. All text goes in through el() (text nodes).
 *
 *   renderFolder(container, scan, { openFile(file, path) })
 */
import { el, bytes, num, day, projectParam } from './ui-util.js';
import { t } from "./i18n.js";

// [pill class, language key]: the text is looked up when drawn (t() never runs at import time).
const STATUS = {
  ok: ['is-ok', 'folder.status.ok'],
  truncated: ['is-bad', 'folder.status.truncated'],
  error: ['is-bad', 'folder.status.error'],
};
const LINK = {
  found: ['is-ok', 'folder.link.found'],
  found_by_name: ['is-warn', 'folder.link.found_by_name'],
  library: ['is-info', 'folder.link.library'],
  missing: ['is-bad', 'folder.link.missing'],
};
const ROLE = {
  linked: (g) => t('folder.role.linked', { models: g.linkedBy.join(', ') }),
  starter: () => t('folder.role.starter'),
  central: () => t('folder.role.central'),
  family: () => t('folder.role.family'),
  backups: () => t('folder.role.backups'),
};
const pill = ([cls, key, text]) => el('span', { className: 'bc-pill ' + cls }, text ?? t(key));
/** A plural string with the number in `n` (picks the form) and formatted in `count`. */
const plural = (key, n, vars = {}) => t(key, { n, count: num(n), ...vars });
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

export function renderFolder(container, scan, { openFile }) {
  const open = (f) => el('button', { type: 'button', className: 'bc-linkbtn', onClick: () => openFile(f.file, f.path) }, baseName(f.path));

  const counts = [
    plural('folder.count.models', scan.models.length),
    scan.cad.length ? plural('folder.count.cad', scan.cad.length) : null,
    scan.ifc.length ? plural('folder.count.ifc', scan.ifc.length) : null,
    scan.bundles?.length ? plural('folder.count.bundles', scan.bundles.length) : null,
    plural('folder.count.files', scan.files),
    bytes(scan.totalSize),
  ].filter(Boolean);
  const missing = scan.links.filter((l) => l.status === 'missing').length;

  const head = el('div', { className: 'bc-folder-head' },
    el('p', { className: 'bc-card-kind' }, t('folder.kind')),
    el('h1', {}, scan.name),
    el('ul', { className: 'meta-items' }, counts.map((c) => el('li', {}, c))),
    el('p', { className: 'bc-muted bc-folder-privacy' }, t('folder.privacy')),
    scan.problems ? el('p', { className: 'bc-folder-alert' }, plural('folder.problems', scan.problems)) : null,
    missing ? el('p', { className: 'bc-folder-alert is-warn' }, plural('folder.missing', missing)) : null,
  );

  // ---- Models ----
  const modelRows = [];
  for (const g of scan.models) {
    const copies = [g.main, ...g.backups].filter(Boolean);
    const bad = copies.filter((c) => c.status !== 'ok');
    const info = g.info;
    const project = info ? (projectParam(info.project, 'Project Name') || info.family?.title || info.project?.title) : null;   // i18n-ignore: Revit parameter name read from the file
    const links = g.links || [];
    const found = links.filter((l) => l.status === 'found' || l.status === 'found_by_name').length;
    const needed = links.filter((l) => l.status !== 'library').length;
    const label = g.best
      ? el('button', { type: 'button', className: 'bc-linkbtn bc-model-name', onClick: () => openFile(g.best.entry.file, g.best.entry.path) }, g.name)
      : el('span', { className: 'bc-model-name' }, g.name);

    const isFocus = scan.focus && scan.focus.group === g;
    const roles = (g.roles || []).map((r) => ROLE[r](g));
    modelRows.push(el('tr', { className: isFocus ? 'is-focus' : '', id: isFocus ? 'bc-focus-row' : null },
      el('th', { scope: 'row' },
        isFocus ? el('span', { className: 'bc-pill is-focus' }, t('folder.starthere')) : null,
        label, g.dir ? el('span', { className: 'bc-sub' }, g.dir + '/') : null,
        roles.length ? el('span', { className: 'bc-roles' }, roles.join('. ')) : null),
      el('td', { 'data-label': t('folder.col.savedin') }, info?.release ? 'Revit ' + info.release : ''),   // i18n-ignore: product name and release year
      el('td', { 'data-label': t('folder.col.project') }, project || ''),
      el('td', { 'data-label': t('folder.col.copies') }, copies.length === 1 ? '1' : plural(g.main ? 'folder.copies.main' : 'folder.copies.backups', g.backups.length)),
      el('td', { 'data-label': t('folder.col.links') }, needed ? t('folder.links.of', { found: num(found), needed: num(needed) }) : (links.length ? t('folder.links.libonly') : t('checks.none'))),
      el('td', { 'data-label': t('bcf.f.status') }, pill(bad.length ? (g.best ? ['is-warn', null, plural('folder.status.some', bad.length)] : STATUS.truncated) : STATUS.ok)),
    ));

    // A note under a model whose main file (or any copy) is bad.
    if (bad.length || copies.length > 1) {
      const notes = [];
      if (g.main && g.main.status !== 'ok') {
        const what = 'folder.main.' + (g.main.status === 'truncated' ? 'truncated' : 'error') + (g.main.expectedAtLeast ? '.expected' : '');
        // keys: folder.main.truncated, folder.main.truncated.expected, folder.main.error, folder.main.error.expected
        notes.push(el('p', {}, t(what, { name: g.name, size: bytes(g.main.entry.file.size), expected: g.main.expectedAtLeast ? bytes(g.main.expectedAtLeast) : '' }) + ' '
          + (g.best ? t('folder.main.best', { file: baseName(g.best.entry.path), date: day(g.best.entry.file.lastModified) }) : t('folder.main.nobest'))));
      }
      const list = el('ul', { className: 'bc-copies' }, copies.map((c) => el('li', {},
        c.status === 'ok' ? open(c.entry) : el('span', {}, baseName(c.entry.path)),
        el('span', { className: 'bc-sub' }, t('folder.file.meta', { size: bytes(c.entry.file.size), date: day(c.entry.file.lastModified) })),
        pill(STATUS[c.status] || STATUS.error),
        c === g.main ? el('span', { className: 'bc-sub' }, t('folder.copy.main')) : (c === g.best ? el('span', { className: 'bc-sub' }, t('folder.copy.newest')) : null),
      )));
      modelRows.push(el('tr', { className: 'bc-model-more' }, el('td', { colSpan: 6 },
        notes,
        el('details', { open: bad.length > 0 }, el('summary', {}, plural('folder.copies.all', copies.length)), list))));
    }
  }

  // "Start here": the model a person would most likely open to work on, and why.
  let focusBox = null;
  if (scan.focus) {
    const g = scan.focus.group, info = g.info;
    const project = projectParam(info.project, 'Project Name') || info.project?.title || '';   // i18n-ignore: Revit parameter name read from the file
    const facts = [info.release ? 'Revit ' + info.release : null,   // i18n-ignore: product name and release year
      project, bytes(g.best.entry.file.size), day(g.best.entry.file.lastModified)].filter(Boolean);
    focusBox = el('section', { className: 'bc-focus', 'aria-labelledby': 'bc-focus-h' },
      el('p', { className: 'bc-focus-k', id: 'bc-focus-h' }, t('folder.starthere')),
      el('p', { className: 'bc-focus-name' },
        el('button', { type: 'button', className: 'bc-linkbtn', onClick: () => openFile(g.best.entry.file, g.best.entry.path) }, baseName(g.best.entry.path)),
        g.dir ? el('span', { className: 'bc-sub' }, g.dir + '/') : null),
      el('ul', { className: 'meta-items' }, facts.map((f) => el('li', {}, f))),
      el('ul', { className: 'bc-focus-why' }, scan.focus.reasons.map((r) => el('li', {}, r))),
      el('p', { className: 'bc-focus-note' }, t('folder.focus.note')),
      el('p', { className: 'bc-focus-actions' },
        el('button', { type: 'button', className: 'btn-plot btn-sm-cc', onClick: () => openFile(g.best.entry.file, g.best.entry.path) }, t('folder.focus.open')),
        el('button', { type: 'button', className: 'btn-line btn-sm-cc', onClick: () => document.getElementById('bc-focus-row')?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, t('folder.focus.show'))));
  }

  const sections = [
    el('section', { className: 'bc-card-sec' },
      el('h2', {}, t('fed.title')),
      scan.models.length
        ? el('table', { className: 'bc-ftable' },
            el('thead', {}, el('tr', {}, [t('ui.stage.label'), t('folder.col.savedin'), t('folder.col.project'), t('folder.col.copies'), t('folder.col.linksfound'),
              t('bcf.f.status')].map((h) => el('th', { scope: 'col' }, h)))),
            el('tbody', {}, modelRows))
        : el('p', { className: 'bc-muted' }, t('folder.models.none'))),
  ];

  if (scan.links.length) {
    sections.push(el('section', { className: 'bc-card-sec' },
      el('h2', {}, t('folder.links.title')),
      el('table', { className: 'bc-ftable' },
        el('thead', {}, el('tr', {}, [t('qto.sp.file'), t('dwg.prop.type'), t('folder.col.usedby'), t('equip.col.where')].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, scan.links.map((l) => el('tr', {},
          el('th', { scope: 'row' }, baseName(l.ref.replace(/\\/g, '/')), el('span', { className: 'bc-sub' }, l.ref)),
          el('td', { 'data-label': t('dwg.prop.type') }, l.type),
          el('td', { 'data-label': t('folder.col.usedby') }, l.usedBy.join(', ')),
          el('td', { 'data-label': t('equip.col.where') }, pill(LINK[l.status]),
            l.match ? el('span', { className: 'bc-sub' }, l.match.path) : null,
            l.status === 'library' ? el('span', { className: 'bc-sub' }, t('folder.link.library.note')) : null),
        )))),
    ));
  }

  if (scan.ifc.length) {
    sections.push(el('section', { className: 'bc-card-sec' },
      el('h2', {}, t('folder.ifc.title')),
      el('ul', { className: 'bc-copies' }, scan.ifc.map((f) => el('li', {},
        el('button', { type: 'button', className: 'bc-linkbtn', onClick: () => openFile(f.file, f.path) }, f.path),
        el('span', { className: 'bc-sub' }, t('folder.ifc.meta', { size: bytes(f.file.size), date: day(f.file.lastModified) }))))),
    ));
  }

  if (scan.bundles?.length) {   // 0.7 BIM-BUNDLE-OPEN: project bundles in the folder open like a model
    sections.push(el('section', { className: 'bc-card-sec', 'data-folder-bundles': '' },
      el('h2', {}, t('folder.bundles.title')),
      el('ul', { className: 'bc-copies' }, scan.bundles.map((f) => el('li', {},
        el('button', { type: 'button', className: 'bc-linkbtn', 'data-folder-bundle': f.path, onClick: () => openFile(f.file, f.path) }, f.path),
        el('span', { className: 'bc-sub' }, t('folder.bundles.meta', { size: bytes(f.file.size), date: day(f.file.lastModified) }))))),
    ));
  }

  if (scan.cad.length) {
    sections.push(el('section', { className: 'bc-card-sec' },
      el('h2', {}, t('folder.cad.title')),
      el('ul', { className: 'bc-copies' }, scan.cad.map((f) => el('li', {},
        /\.(dwg|dxf)$/i.test(f.path) ? el('button', { type: 'button', className: 'bc-linkbtn', onClick: () => openFile(f.file, f.path) }, f.path) : el('span', {}, f.path),
        el('span', { className: 'bc-sub' }, t(f.usedBy.length ? 'folder.cad.meta.linked' : 'folder.file.meta', { size: bytes(f.file.size), date: day(f.file.lastModified), models: f.usedBy.join(', ') }))))),
      el('p', { className: 'bc-muted' }, t('folder.cad.hint')),
    ));
  }

  const setAside = [];
  if (scan.housekeeping.length) setAside.push(el('p', {}, t('folder.aside.housekeeping', { list: scan.housekeeping.map((h) => h.path).join(', ') })));
  if (scan.leftovers.length) setAside.push(el('p', {}, t('folder.aside.leftovers', { list: scan.leftovers.map((f) => baseName(f.path)).join(', ') })));
  if (scan.other.length) {
    const list = scan.other.slice(0, 40).map((f) => f.path).join(', ');
    setAside.push(el('p', {}, scan.other.length > 40 ? t('folder.aside.other.more', { list, n: scan.other.length - 40 }) : t('folder.aside.other', { list })));
  }
  if (setAside.length) sections.push(el('section', { className: 'bc-card-sec bc-setaside' }, el('h2', {}, t('folder.aside.title')), setAside));

  container.replaceChildren(head, focusBox, ...sections.filter(Boolean));
  container.scrollTop = 0;
}
