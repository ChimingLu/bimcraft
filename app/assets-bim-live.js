/* SPDX-License-Identifier: Apache-2.0 */
/**
 * assets-bim-live.js — live sensor feeds straight from the browser (0.7 LC.12 item 4, session bim-ops). DOM-free:
 * node bin/test-bimcraft.mjs --ops --only feeds (a test broker and endpoint in tools/bimcraft-test/ops-broker.mjs).
 *
 * The person points BimCraft at THEIR OWN broker or endpoint; nothing runs on our server and nothing passes through it.
 * Readings go into the session's SensorStore (assets-bim-sensors.js), never into the IFC. A user name, password or token is
 * held only by the running client object (memory) — never in localStorage, never in the IFC. Nothing connects until the
 * person clicks Connect.
 *
 * MQTT 3.1.1 over WebSockets (OASIS MQTT 3.1.1, §§ 2–3, the WebSocket transport of § 6; subprotocol "mqtt"):
 *   encodeLength(n) / decodeLength(bytes, at) → { n, size }      the "remaining length" (1–4 bytes, ≤ 268 435 455)
 *   connectPacket({ clientId, username, password, keepAlive }) · subscribePacket(id, filters) · pubackPacket(id)
 *   PINGREQ, DISCONNECT (bytes) · new PacketReader({ max }) .push(bytes) → [packet] (CONNACK, SUBACK, PUBLISH, PINGRESP,
 *   UNSUBACK) — a packet over `max` bytes (default 256 KB) is refused, never buffered
 *   topicMatches(filter, topic) (+ and #) · templateFilter('site/{tag}/temp') → 'site/+/temp' · templateTag(template, topic)
 *   new MqttClient({ WebSocket, setTimeout, clearTimeout, now }) .connect({ url, topics: [template], username, password,
 *       keepAlive }) .close(); events onState(state, detail) ('connecting' | 'connected' | 'closed' | 'error'),
 *       onReading({ key, v, t }) where key is the {tag} part of the topic (or the whole topic with no {tag})
 * HTTP polling:
 *   new HttpPoller({ fetch, setTimeout, clearTimeout }) .start({ url, every (s, ≥ MIN_EVERY), token }) .stop()
 *       fetch with credentials 'omit' and no cache; a token goes as "Authorization: Bearer …"; ≤ MAX_BODY bytes read;
 *       on failure the wait doubles up to MAX_BACKOFF; events onState, onReading as above
 *   readPoll(text, contentType, { valueKey, timeKey }) → [{ key, v, t }]   JSON object { tag: value | { value, time } },
 *       JSON array [{ tag | id | name, value, time }], or CSV (assets-bim-sensors parseSensorCsv: every row)
 *   readPayload(bytes | text, { valueKey, timeKey }) → { v, t } | null   a number, or JSON { value, time }
 *   feedUrl(url, kind, pageProtocol) → '' | error key   ws(s) for MQTT, http(s) for polling; no user:password@ in it;
 *       from an https page only wss / https (a browser blocks the rest) except the person's own computer (localhost)
 * The feed's settings may be kept in the IFC when the person asks (never a password or token: there is no field for one):
 *   readFeedSettings(api, mid) → { kind, url, topics: [], valueKey, every } | null   the CadCraft_Feed set on IfcProject
 *   feedSettingsOp({ kind, url, topics, valueKey, every }) → op for IfcEditor.modelChange (one undo step); url checked by feedUrl
 */
import { parseSensorCsv, timeOf, numOf } from './assets-bim-sensors.js';
import { ModelWriter } from './model-write.js';
import { ids } from './ifc-util.js';

export const MIN_EVERY = 5, MAX_BACKOFF = 300, MAX_BODY = 5 * 1024 * 1024, MAX_PACKET = 256 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder();
const err = (key) => Object.assign(new Error(key), { key });

// ---------------------------------------------------------------- addresses
export function feedUrl(url, kind = 'mqtt', pageProtocol = 'https:') {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return 'assets.live.err.url'; }
  const want = kind === 'mqtt' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!want.includes(u.protocol)) return kind === 'mqtt' ? 'assets.live.err.ws' : 'assets.live.err.http';
  if (u.username || u.password) return 'assets.live.err.userinfo';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (pageProtocol === 'https:' && (u.protocol === 'ws:' || u.protocol === 'http:') && !local) return 'assets.live.err.insecure';
  return '';
}

// ---------------------------------------------------------------- MQTT 3.1.1 packets
export function encodeLength(n) {
  if (!(n >= 0 && n <= 268435455)) throw err('assets.live.err.packet');
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return out;
}
export function decodeLength(b, at) {
  let n = 0, mul = 1, i = 0;
  for (;;) {
    if (at + i >= b.length) return null;   // more bytes needed
    const x = b[at + i++];
    n += (x & 127) * mul;
    if (!(x & 128)) return { n, size: i };
    mul *= 128;
    if (i >= 4) throw err('assets.live.err.packet');
  }
}
const str = (s) => { const b = enc.encode(String(s)); if (b.length > 65535) throw err('assets.live.err.packet'); return [b.length >> 8, b.length & 255, ...b]; };
const packet = (type, flags, body) => Uint8Array.from([(type << 4) | flags, ...encodeLength(body.length), ...body]);

export function connectPacket({ clientId = '', username = '', password = '', keepAlive = 30 } = {}) {
  let flags = 0x02;   // clean session
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const body = [...str('MQTT'), 4, flags, keepAlive >> 8, keepAlive & 255, ...str(clientId), ...(username ? str(username) : []), ...(password ? str(password) : [])];
  return packet(1, 0, body);
}
export function subscribePacket(id, filters) { return packet(8, 2, [id >> 8, id & 255, ...filters.flatMap((f) => [...str(f), 1])]); }   // QoS 1 asked
export const pubackPacket = (id) => packet(4, 0, [id >> 8, id & 255]);
export const PINGREQ = Uint8Array.from([0xc0, 0]), DISCONNECT = Uint8Array.from([0xe0, 0]);

export class PacketReader {
  constructor({ max = MAX_PACKET } = {}) { this.max = max; this.buf = new Uint8Array(0); }
  push(bytes) {
    const b = new Uint8Array(this.buf.length + bytes.length);
    b.set(this.buf); b.set(bytes, this.buf.length);
    const out = [];
    let at = 0;
    for (;;) {
      if (b.length - at < 2) break;
      const L = decodeLength(b, at + 1);
      if (!L) break;
      if (L.n > this.max) throw err('assets.live.err.too-big');
      const start = at + 1 + L.size, end = start + L.n;
      if (end > b.length) break;
      out.push(parsePacket(b[at], b.subarray(start, end)));
      at = end;
    }
    this.buf = b.slice(at);
    if (this.buf.length > this.max + 5) throw err('assets.live.err.too-big');
    return out;
  }
}
function parsePacket(h, body) {
  const type = h >> 4, flags = h & 15;
  if (type === 2) return { type: 'CONNACK', sessionPresent: !!(body[0] & 1), code: body[1] };
  if (type === 9) return { type: 'SUBACK', id: (body[0] << 8) | body[1], codes: [...body.subarray(2)] };
  if (type === 11) return { type: 'UNSUBACK', id: (body[0] << 8) | body[1] };
  if (type === 13) return { type: 'PINGRESP' };
  if (type === 3) {
    const qos = (flags >> 1) & 3, tl = (body[0] << 8) | body[1];
    const topic = dec.decode(body.subarray(2, 2 + tl));
    let at = 2 + tl, id = null;
    if (qos > 0) { id = (body[at] << 8) | body[at + 1]; at += 2; }
    return { type: 'PUBLISH', topic, qos, id, retain: !!(flags & 1), dup: !!(flags & 8), payload: body.slice(at) };
  }
  return { type: 'OTHER', code: type };
}

// ---------------------------------------------------------------- topics
export function topicMatches(filter, topic) {
  const f = String(filter).split('/'), t = String(topic).split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;   // the rest, and the parent level itself ("a/#" matches "a"): MQTT 3.1.1 § 4.7.1.2
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
export const templateFilter = (tpl) => String(tpl).replace(/\{tag\}/g, '+');
/** The {tag} part of a topic for a template; with no {tag} the topic itself names the sensor. null = not this template's. */
export function templateTag(tpl, topic) {
  if (!topicMatches(templateFilter(tpl), topic)) return null;
  const i = String(tpl).split('/').indexOf('{tag}');
  return i < 0 ? topic : String(topic).split('/')[i];
}

// ---------------------------------------------------------------- payloads
export function readPayload(p, { valueKey = 'value', timeKey = 'time' } = {}) {
  const s = (typeof p === 'string' ? p : dec.decode(p)).trim();
  if (!s || s.length > 64 * 1024) return null;
  const n = numOf(s);
  if (Number.isFinite(n)) return { v: n, t: null };
  if (s[0] !== '{') return null;
  let o;
  try { o = JSON.parse(s); } catch { return null; }
  const v = typeof o?.[valueKey] === 'number' ? o[valueKey] : numOf(o?.[valueKey]);
  if (!Number.isFinite(v)) return null;
  const tt = o[timeKey] ?? o.ts ?? o.timestamp;
  const t = typeof tt === 'number' ? (tt < 1e11 ? tt * 1000 : tt) : timeOf(tt);
  return { v, t: Number.isFinite(t) ? t : null };
}
export function readPoll(text, contentType = '', opts = {}) {
  const s = String(text ?? '').trim(), out = [];
  if (/json/i.test(contentType) || s[0] === '{' || s[0] === '[') {
    let o;
    try { o = JSON.parse(s); } catch { throw err('assets.live.err.body'); }
    const one = (key, x) => { const r = typeof x === 'object' && x !== null ? readPayload(JSON.stringify(x), opts) : readPayload(String(x), opts); if (r && key) out.push({ key: String(key).slice(0, 120), v: r.v, t: r.t }); };
    if (Array.isArray(o)) for (const x of o.slice(0, 5000)) one(x?.tag ?? x?.id ?? x?.name, x);
    else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o).slice(0, 5000)) one(k, x);
    return out;
  }
  const p = parseSensorCsv(s);
  for (const c of p.cols) for (let i = 0; i < p.times.length; i++) if (Number.isFinite(c.values[i])) out.push({ key: c.head, v: c.values[i], t: p.times[i] });
  return out;
}

// ---------------------------------------------------------------- the MQTT client
export class MqttClient {
  constructor({ WebSocket = globalThis.WebSocket, setTimeout: st = (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: ct = (h) => globalThis.clearTimeout(h), now = () => Date.now() } = {}) {
    Object.assign(this, { WS: WebSocket, st, ct, now, ws: null, state: 'closed', onState: () => {}, onReading: () => {}, nextId: 1, timer: null, opts: null });
  }
  set(state, detail = '') { this.state = state; this.onState(state, detail); }
  connect({ url, topics = [], username = '', password = '', keepAlive = 30, clientId = '', valueKey = 'value', timeKey = 'time' } = {}) {
    this.close();
    if (!topics.length) throw err('assets.live.err.topic');
    for (const tp of topics) if (!tp || /[\u0000#]/.test(tp.replace(/\/#$/, '')) || tp.length > 512) throw err('assets.live.err.topic');
    this.opts = { topics, valueKey, timeKey, keepAlive };
    const reader = new PacketReader();
    const cid = clientId || 'bimcraft-' + Math.random().toString(36).slice(2, 10);
    // the credentials go into the CONNECT bytes now; those are dropped once sent (nothing else keeps them)
    let hello = connectPacket({ clientId: cid, username, password, keepAlive });
    this.set('connecting');
    let ws;
    try { ws = new this.WS(url, ['mqtt']); } catch (e) { this.set('error', String(e.message || e)); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { ws.send(hello); hello = null; };
    ws.onmessage = (ev) => {
      let packets;
      try { packets = reader.push(new Uint8Array(ev.data instanceof ArrayBuffer ? ev.data : enc.encode(String(ev.data)))); }
      catch (e) { this.set('error', e.key || e.message); this.close(); return; }
      for (const p of packets) this.packet(p);
    };
    ws.onerror = () => { if (this.state !== 'closed') this.set('error', 'socket'); };
    ws.onclose = () => { hello = null; this.ct(this.timer); this.timer = null; if (this.ws === ws) { this.ws = null; if (this.state !== 'error') this.set('closed'); } };
  }
  packet(p) {
    if (p.type === 'CONNACK') {
      if (p.code !== 0) { this.set('error', 'refused-' + p.code); this.close(); return; }
      this.ws.send(subscribePacket(this.nextId++, this.opts.topics.map(templateFilter)));
      this.set('connected');
      this.ping();
    } else if (p.type === 'SUBACK') {
      if (p.codes.some((c) => c === 0x80)) this.set('error', 'subscribe');
    } else if (p.type === 'PUBLISH') {
      if (p.qos === 1 && p.id !== null) this.ws.send(pubackPacket(p.id));
      for (const tpl of this.opts.topics) {
        const key = templateTag(tpl, p.topic);
        if (key === null) continue;
        const r = readPayload(p.payload, this.opts);
        if (r) this.onReading({ key, v: r.v, t: r.t ?? this.now(), topic: p.topic });
        break;
      }
    }
  }
  ping() { this.ct(this.timer); const k = this.opts.keepAlive; if (k > 0) this.timer = this.st(() => { if (this.ws && this.state === 'connected') { this.ws.send(PINGREQ); this.ping(); } }, k * 1000 * 0.75); }
  close() {
    this.ct(this.timer); this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { if (ws.readyState === 1) ws.send(DISCONNECT); ws.close(); } catch { /* gone */ } }
    if (this.state !== 'closed') this.set('closed');
  }
}

// ---------------------------------------------------------------- HTTP polling
export class HttpPoller {
  constructor({ fetch: f = globalThis.fetch?.bind(globalThis), setTimeout: st = (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: ct = (h) => globalThis.clearTimeout(h), now = () => Date.now() } = {}) {
    Object.assign(this, { fetch: f, st, ct, now, timer: null, ctl: null, state: 'closed', onState: () => {}, onReading: () => {}, run: 0 });
  }
  set(state, detail = '') { this.state = state; this.onState(state, detail); }
  start({ url, every = 30, token = '', valueKey = 'value', timeKey = 'time' } = {}) {
    this.stop();
    const base = Math.max(MIN_EVERY, Number(every) || 30);
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const run = ++this.run;
    let wait = base;
    const tick = async () => {
      if (run !== this.run) return;
      this.ctl = typeof AbortController === 'function' ? new AbortController() : null;
      try {
        const res = await this.fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', headers, signal: this.ctl?.signal });
        if (!res.ok) throw err('http-' + res.status);
        const n = Number(res.headers?.get?.('content-length'));
        if (n > MAX_BODY) throw err('assets.live.err.too-big');
        const text = await res.text();
        if (text.length > MAX_BODY) throw err('assets.live.err.too-big');
        const got = readPoll(text, res.headers?.get?.('content-type') || '', { valueKey, timeKey });
        if (run !== this.run) return;
        for (const r of got) this.onReading({ ...r, t: r.t ?? this.now() });
        wait = base;
        this.set('connected', String(got.length));
      } catch (e) {
        if (run !== this.run) return;
        wait = Math.min(MAX_BACKOFF, wait * 2);
        this.set('error', e.key || e.message || 'fetch');
      }
      if (run === this.run) this.timer = this.st(tick, wait * 1000);
    };
    this.set('connecting');
    tick();
  }
  stop() { this.run++; this.ct(this.timer); this.timer = null; try { this.ctl?.abort(); } catch { /* none */ } this.ctl = null; if (this.state !== 'closed') this.set('closed'); }
}

// ---------------------------------------------------------------- settings kept in the IFC (no secrets)
export const FEED_SET = 'CadCraft_Feed';
const projectOf = (api, mid) => { try { return ids(api, mid, 'IFCPROJECT')[0]; } catch { return undefined; } };
export function readFeedSettings(api, mid) {
  const pj = projectOf(api, mid);
  if (pj === undefined) return null;
  const w = new ModelWriter(null, api, mid);
  const ps = w.readPset(pj, FEED_SET);
  if (!ps) return null;
  const kind = ps.Kind === 'http' ? 'http' : 'mqtt';
  const topics = Object.keys(ps).filter((k) => /^Topic\d+$/.test(k)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map((k) => String(ps[k] ?? '').trim()).filter(Boolean).slice(0, 20);
  return { kind, url: String(ps.Address ?? '').slice(0, 2000), topics,
    valueKey: String(ps.ValueKey ?? 'value').slice(0, 60) || 'value', every: Math.max(MIN_EVERY, Number(ps.Every) || 30) };
}
export function feedSettingsOp({ kind = 'mqtt', url = '', topics = [], valueKey = 'value', every = 30 } = {}) {
  const bad = feedUrl(url, kind, 'http:');   // the page's own scheme is checked at Connect; here only the address itself
  if (bad) throw err(bad);
  const tps = (Array.isArray(topics) ? topics : String(topics).split('\n')).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => {
      const pj = projectOf(ed.api, ed.mid);
      if (pj === undefined) throw err('assets.live.err.project');
      // the set is ours alone: written whole each time (Topic1… one property per topic, so none is left over)
      const d = w.defNamed(pj, FEED_SET);
      if (d) { const props = (d.line.HasProperties || []).map((h) => h.value); w.dropProduct([d.def]); for (const p of props) w.dropTree(p); w._defs = null; }
      w.relateDef(pj, w.pset(FEED_SET, [['Kind', 'IFCLABEL', kind === 'http' ? 'http' : 'mqtt'], ['Address', 'IFCTEXT', String(url).trim()],
        ...tps.map((tp, i) => ['Topic' + (i + 1), 'IFCLABEL', tp.slice(0, 255)]), ['ValueKey', 'IFCLABEL', String(valueKey || 'value').slice(0, 60)], ['Every', 'IFCREAL', Math.max(MIN_EVERY, Number(every) || 30)]]));
      return { id: pj };
    });
  };
}
