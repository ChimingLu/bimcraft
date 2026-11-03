/* SPDX-License-Identifier: Apache-2.0 */
/**
 * assets-bim-live-ui.js — the Live feed part of BimCraft's Assets tab (0.7 LC.12 item 4, session bim-ops): readings from the
 * person's own MQTT broker (over WebSockets) or an HTTP endpoint they poll, straight from the browser, into the session's
 * sensor store (assets-bim-sensors-ui.js SENSORS). Nothing connects until Connect is clicked; nothing passes through our
 * server; the password or token is read from its box at Connect, handed to the client and the box cleared — it is never
 * saved (no localStorage, no IFC). "Keep these settings in the IFC" writes the address, topics, value key and interval only.
 *
 *   liveSection(host, ctx) → element      ctx = { assets(), commit(op, label), render(), soft() (a redraw that waits while
 *                                          the person is typing in the tab) }
 *   LIVE — the running feed: { client, kind, state, detail, count, last, unmatched: Set, form }
 */
import { el } from './ui-util.js';
import { t } from './i18n.js';
import { SENSORS } from './assets-bim-sensors-ui.js';
import { matchSensors } from './assets-bim-sensors.js';
import { MqttClient, HttpPoller, feedUrl, readFeedSettings, feedSettingsOp, MIN_EVERY } from './assets-bim-live.js';

export const LIVE = { client: null, kind: 'mqtt', state: 'closed', detail: '', count: 0, last: 0, unmatched: new Set(), form: null, from: null, open: false, ran: false };
const blankForm = () => ({ kind: 'mqtt', url: '', topics: 'site/{tag}/temperature', user: '', valueKey: 'value', every: 30 });   // i18n-ignore: an example MQTT topic

export function stopFeed() { try { LIVE.client?.close?.(); LIVE.client?.stop?.(); } catch { /* gone */ } LIVE.client = null; }

export function liveSection(host, ctx) {
  const e = host.editor();
  // the form starts from the settings kept in this file (once per file), else from the last typed values
  const fileSettings = e ? readFeedSettings(e.api, e.mid) : null;
  const sig = e ? e.mid + ':' + JSON.stringify(fileSettings) : '';
  if (!LIVE.form || (LIVE.from !== sig && fileSettings)) { LIVE.form = fileSettings ? { ...blankForm(), ...fileSettings, topics: fileSettings.topics.join('\n') } : LIVE.form || blankForm(); LIVE.from = sig; }
  const F = LIVE.form;
  let secretBox = null;

  function connect() {
    const kind = F.kind;
    const bad = feedUrl(F.url, kind, location.protocol);
    if (bad) { host.status(t(bad), true); return; }
    const secret = secretBox?.value || '';
    if (secretBox) secretBox.value = '';   // handed to the client below; never kept by the page
    stopFeed();
    LIVE.count = 0; LIVE.last = 0; LIVE.unmatched = new Set(); LIVE.ran = true;
    let byKey = new Map();
    const onReading = ({ key, v, t: at }) => {
      if (!byKey.has(key)) { const m = matchSensors([key], ctx.assets()); byKey.set(key, m.byHead.get(key) || null); }
      const a = byKey.get(key);
      if (!a) { LIVE.unmatched.add(String(key).slice(0, 60)); ctx.soft(); return; }
      if (SENSORS.store.push(a.guid, at, v)) { LIVE.count++; LIVE.last = at; }
      ctx.soft();
    };
    const onState = (s, d) => { LIVE.state = s; LIVE.detail = d || ''; if (s === 'connected' && kind === 'mqtt') byKey = new Map(); ctx.soft(); };
    try {
      if (kind === 'mqtt') {
        const c = new MqttClient();
        c.onState = onState; c.onReading = onReading;
        LIVE.client = c;
        c.connect({ url: F.url.trim(), topics: String(F.topics).split('\n').map((s) => s.trim()).filter(Boolean), username: F.user.trim(), password: secret, valueKey: F.valueKey || 'value' });
      } else {
        const p = new HttpPoller();
        p.onState = onState; p.onReading = onReading;
        LIVE.client = p;
        p.start({ url: F.url.trim(), every: F.every, token: secret, valueKey: F.valueKey || 'value' });
      }
      LIVE.kind = kind;
      SENSORS.open = true;
    } catch (err) { host.status(err.key ? t(err.key) : String(err.message || err), true); }
    ctx.render();
  }
  function keep() {
    try {
      if (ctx.commit(feedSettingsOp({ kind: F.kind, url: F.url, topics: String(F.topics).split('\n'), valueKey: F.valueKey, every: F.every }), t('assets.live.label'))) host.status(t('assets.live.kept'));
    } catch (err) { host.status(err.key ? t(err.key) : String(err.message || err), true); }
  }

  const running = !!LIVE.client && LIVE.state !== 'closed';
  const input = (k, type, extra = {}) => el('input', { type, className: 'bc-input fa-input', value: String(F[k] ?? ''), 'data-as-live': k, disabled: running, oninput: (ev) => { F[k] = ev.target.value; }, ...extra });
  const field = (k, control) => el('label', { className: 'fa-field' }, el('span', {}, t('assets.live.f.' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()))), control);   // valueKey → value-key
  secretBox = el('input', { type: 'password', className: 'bc-input fa-input', autocomplete: 'off', 'data-as-live-secret': '', disabled: running, placeholder: t('assets.live.secret.hint') });
  const stateText = LIVE.ran ? t('assets.live.state.' + LIVE.state, { detail: LIVE.detail, n: LIVE.count }) : t('assets.live.state.off');
  return el('details', { className: 'as-cobie', 'data-as-live-sec': '', open: LIVE.open || running, ontoggle: (ev) => { LIVE.open = ev.target.open; } },
    el('summary', {}, t('assets.live.h')),
    el('p', { className: 'bc-muted' }, t('assets.live.intro')),
    el('div', { className: 'fa-row' },
      el('label', { className: 'fa-check' }, el('input', { type: 'radio', name: 'as-live-kind', value: 'mqtt', checked: F.kind === 'mqtt', disabled: running, 'data-as-live-kind': 'mqtt', onchange: () => { F.kind = 'mqtt'; ctx.render(); } }), t('assets.live.kind.mqtt')),
      el('label', { className: 'fa-check' }, el('input', { type: 'radio', name: 'as-live-kind', value: 'http', checked: F.kind === 'http', disabled: running, 'data-as-live-kind': 'http', onchange: () => { F.kind = 'http'; ctx.render(); } }), t('assets.live.kind.http'))),
    field('url', input('url', 'url', { placeholder: F.kind === 'mqtt' ? 'wss://broker.example.com:8884/mqtt' : 'https://bms.example.com/api/readings' })),
    F.kind === 'mqtt' ? field('topics', el('textarea', { className: 'bc-input fa-input', rows: 2, 'data-as-live': 'topics', disabled: running, oninput: (ev) => { F.topics = ev.target.value; } }, F.topics)) : field('every', input('every', 'number', { min: String(MIN_EVERY), step: '1' })),
    el('div', { className: 'as-form' },
      F.kind === 'mqtt' ? field('user', input('user', 'text', { autocomplete: 'off' })) : null,
      el('label', { className: 'fa-field' }, el('span', {}, t(F.kind === 'mqtt' ? 'assets.live.f.password' : 'assets.live.f.token')), secretBox),
      field('valueKey', input('valueKey', 'text'))),
    el('p', { className: 'bc-muted' }, t('assets.live.secret')),
    el('div', { className: 'fa-head' },
      running ? el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-as-live-stop': '', onclick: () => { stopFeed(); LIVE.state = 'closed'; ctx.render(); } }, t('assets.live.btn.stop'))
        : el('button', { type: 'button', className: 'btn-plot btn-sm-cc', 'data-as-live-go': '', onclick: connect }, t('assets.live.btn.go')),
      el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-as-live-keep': '', onclick: keep }, t('assets.live.btn.keep'))),
    el('p', { className: LIVE.state === 'error' ? 'fa-warn' : 'bc-muted', 'data-as-live-state': LIVE.state, role: 'status' }, stateText,
      LIVE.last ? ' ' + t('assets.live.last', { when: new Date(LIVE.last).toLocaleTimeString() }) : ''),
    LIVE.unmatched.size ? el('p', { className: 'bc-muted', 'data-as-live-unmatched': '' }, t('assets.live.unmatched', { n: LIVE.unmatched.size, names: [...LIVE.unmatched].slice(0, 6).join(', ') })) : null);
}
