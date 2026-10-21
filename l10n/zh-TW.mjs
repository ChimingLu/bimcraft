#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * zh-TW.mjs — keep the Traditional Chinese (Taiwan) language files in step with the English source after an upstream
 * update (l10n/README.zh-TW.md). Node 20+, no packages.
 *
 *   node l10n/zh-TW.mjs check            what needs work: new keys, English that changed since it was translated,
 *                                         keys upstream removed, broken {fills} or plural forms. Exit 1 when a file
 *                                         is broken; with --strict also when anything is untranslated or out of date.
 *   node l10n/zh-TW.mjs todo             write l10n/zh-TW/todo.json: every key that needs a (new) translation, with
 *                                         the English now ("en"), the English it was translated from ("was") and the
 *                                         current translation ("zh") — fill in "zh" and run apply.
 *   node l10n/zh-TW.mjs apply [file]     put the translations from todo.json (or file) into the language files,
 *                                         record the English they translate in l10n/zh-TW/baseline.json, drop keys
 *                                         upstream removed, and write each file in the English file's key order.
 *
 * The language files themselves sit where the app reads them (app/lang/zh-TW.json, the shell's lang/shell/zh-TW.json):
 * both are new files upstream never touches, so merging an upstream update never conflicts on them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALE = 'zh-TW';
const META = { '@locale': LOCALE, '@name': '繁體中文（台灣）' };
const FILES = {
  app: { en: 'app/lang/en.json', zh: `app/lang/${LOCALE}.json` },
  shell: { en: 'devshell/site/assets/lang/shell/en.json', zh: `devshell/site/assets/lang/shell/${LOCALE}.json` },
};
const DIR = path.join(ROOT, 'l10n', LOCALE);
const BASELINE = path.join(DIR, 'baseline.json');
const TODO = path.join(DIR, 'todo.json');
const FILL_RE = /\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const readJson = (p, dflt) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt);
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const strings = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('@')));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPlural = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fillsOf = (v) => {
  const out = new Set();
  for (const s of isPlural(v) ? Object.values(v) : [v]) for (const m of String(s).matchAll(FILL_RE)) if (m[1]) out.add(m[1]);
  return [...out].sort();
};

/** What is wrong with one translation (empty = fine). */
function problemsOf(en, zh) {
  const out = [];
  if (isPlural(en) !== isPlural(zh)) out.push(isPlural(en) ? 'English is a plural object, the translation is not' : 'English is text, the translation is a plural object');
  else if (isPlural(zh)) {
    if (typeof zh.other !== 'string') out.push('plural without "other"');
    for (const [k, v] of Object.entries(zh)) if (typeof v !== 'string') out.push(`plural form ${k} is not text`);
  } else if (typeof zh !== 'string') out.push('not text');
  // every fill the translation uses must exist in English (a fill English has may be left out only on purpose: warn)
  const ef = fillsOf(en), zf = fillsOf(zh);
  const extra = zf.filter((f) => !ef.includes(f));
  if (extra.length) out.push(`fills English does not have: ${extra.map((f) => `{${f}}`).join(' ')}`);
  return out;
}

function load() {
  const base = readJson(BASELINE, {});
  const parts = {};
  for (const [name, f] of Object.entries(FILES)) {
    const en = readJson(path.join(ROOT, f.en));
    const zhFile = readJson(path.join(ROOT, f.zh), {});
    parts[name] = { en: strings(en), enMeta: en, zh: strings(zhFile), base: base[name] || {} };
  }
  return { base, parts };
}

function survey(p) {
  const r = { missing: [], stale: [], obsolete: [], broken: [], dropped: [] };
  for (const [k, en] of Object.entries(p.en)) {
    if (!(k in p.zh)) { r.missing.push(k); continue; }
    if (k in p.base && !same(p.base[k], en)) r.stale.push(k);
    const bad = problemsOf(en, p.zh[k]);
    if (bad.length) r.broken.push([k, bad]);
    const lost = fillsOf(en).filter((f) => !fillsOf(p.zh[k]).includes(f));
    if (lost.length && !bad.length) r.dropped.push([k, lost]);
  }
  for (const k of Object.keys(p.zh)) if (!(k in p.en)) r.obsolete.push(k);
  return r;
}

function check(strict) {
  const { parts } = load();
  let broken = 0, work = 0;
  for (const [name, p] of Object.entries(parts)) {
    const r = survey(p);
    const total = Object.keys(p.en).length, done = total - r.missing.length;
    console.log(`\n${name}: ${done}/${total} translated (${(100 * done / total).toFixed(1)}%)  ${FILES[name].zh}`);
    const list = (label, keys) => { if (keys.length) console.log(`  ${label} (${keys.length}): ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}`); };
    list('new in English, not translated', r.missing);
    list('English changed since translated', r.stale);
    list('removed upstream (apply drops them)', r.obsolete);
    for (const [k, bad] of r.broken) console.log(`  BROKEN ${k}: ${bad.join('; ')}`);
    for (const [k, lost] of r.dropped) console.log(`  note ${k}: does not show ${lost.map((f) => `{${f}}`).join(' ')}`);
    broken += r.broken.length;
    work += r.missing.length + r.stale.length + r.obsolete.length;
  }
  console.log(work ? `\n${work} to do: node l10n/zh-TW.mjs todo` : '\nUp to date.');
  process.exit(broken || (strict && work) ? 1 : 0);
}

function todo() {
  const { parts } = load();
  const out = {};
  let n = 0;
  for (const [name, p] of Object.entries(parts)) {
    const r = survey(p);
    const keys = [...r.missing, ...r.stale, ...r.broken.map(([k]) => k)];
    if (!keys.length) continue;
    out[name] = {};
    for (const k of Object.keys(p.en)) {
      if (!keys.includes(k)) continue;
      const e = { en: p.en[k] };
      if (k in p.base && !same(p.base[k], p.en[k])) e.was = p.base[k];
      e.zh = p.zh[k] ?? '';
      const note = p.enMeta['@context']?.[k];
      if (note) e.context = note;
      out[name][k] = e;
      n++;
    }
  }
  if (!n) { console.log('Nothing to translate.'); if (fs.existsSync(TODO)) fs.rmSync(TODO); return; }
  writeJson(TODO, out);
  console.log(`${n} keys in ${path.relative(ROOT, TODO)}: fill in each "zh", then node l10n/zh-TW.mjs apply`);
}

function apply(file) {
  const src = file ? path.resolve(file) : TODO;
  const input = readJson(src, null);
  if (!input) { console.error(`no ${path.relative(ROOT, src)}`); process.exit(2); }
  const { base, parts } = load();
  let problems = 0, applied = 0, left = 0;
  for (const [name, p] of Object.entries(parts)) {
    const got = input[name] || {};
    for (const [k, e] of Object.entries(got)) {
      // a todo entry {en, was, zh, context}, or the translation itself ("譯文" or a plural {other: …})
      const text = isPlural(e) && 'en' in e ? e.zh : e;
      if (!(k in p.en)) { console.error(`${name}: ${k} is not in English (any more)`); problems++; continue; }
      if ((text === '' && p.en[k] !== '') || text == null || (isPlural(text) && !text.other)) { left++; continue; }
      const bad = problemsOf(p.en[k], text);
      if (bad.length) { console.error(`${name}: ${k}: ${bad.join('; ')}`); problems++; continue; }
      p.zh[k] = text;
      p.base[k] = p.en[k];
      applied++;
    }
    // the file in the English order, without keys upstream removed
    const ordered = { ...META };
    if (name === 'app') ordered['@note'] = 'Traditional Chinese (Taiwan). Kept in step with upstream by l10n/zh-TW.mjs (l10n/README.zh-TW.md).';
    for (const k of Object.keys(p.en)) if (k in p.zh) ordered[k] = p.zh[k];
    writeJson(path.join(ROOT, FILES[name].zh), ordered);
    base[name] = Object.fromEntries(Object.keys(p.en).filter((k) => k in p.base && k in p.zh).map((k) => [k, p.base[k]]));
  }
  writeJson(BASELINE, base);
  console.log(`${applied} translations applied${left ? `, ${left} still empty` : ''}${problems ? `, ${problems} refused` : ''}.`);
  if (!problems && !left && src === TODO) fs.rmSync(TODO);
  process.exit(problems ? 1 : 0);
}

const [cmd = 'check', ...rest] = process.argv.slice(2);
if (cmd === 'check') check(rest.includes('--strict'));
else if (cmd === 'todo') todo();
else if (cmd === 'apply') apply(rest.find((a) => !a.startsWith('--')));
else { console.error('usage: node l10n/zh-TW.mjs check [--strict] | todo | apply [file]'); process.exit(2); }
