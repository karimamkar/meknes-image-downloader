/**
 * SDAL Meknès — Worker Cloudflare
 * - Sert le site statique (public/) via le binding ASSETS
 * - /api/log            : enregistre les opérations des utilisateurs (IP, pays, navigateur…)
 * - /api/admin/*        : consultation du registre, protégée par clé + session
 * Stockage : Durable Object SQLite (créé automatiquement au déploiement).
 *
 * Sécurité de l'administration :
 * - la clé n'est jamais stockée : seule son empreinte SHA-256 (ADMIN_KEY_HASH) est connue du Worker ;
 * - comparaison en temps constant ;
 * - verrouillage après 5 échecs par IP (15 min), et blocage global après 20 échecs/heure ;
 * - session aléatoire (256 bits) côté serveur, cookie __Host- HttpOnly Secure SameSite=Strict, 8 h, liée au navigateur ;
 * - contrôle d'origine sur toutes les requêtes POST, en-têtes de sécurité (CSP, no-store, noindex) sur l'administration.
 */
import { DurableObject } from 'cloudflare:workers';

const EVENT_TYPES = new Set([
  'visit', 'type', 'view', 'search', 'filter_add', 'filter_clear', 'armoire_select',
  'detail_open', 'zip_element', 'batch_plan', 'batch_start', 'batch_end', 'links_export', 'help_open',
]);
const SESSION_TTL = 8 * 3600 * 1000;
const RETENTION_DAYS = 365;
const MAX_FAILS_IP = 5, LOCK_MS = 15 * 60 * 1000, MAX_FAILS_GLOBAL = 20;
const LOG_RATE_PER_MIN = 120;

/* ---------------- Utilitaires ---------------- */
const enc = new TextEncoder();
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}
function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const ADMIN_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};

function clientInfo(req) {
  const cf = req.cf || {};
  return {
    ip: req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '0.0.0.0',
    country: cf.country || '', city: cf.city || '', asn: cf.asOrganization || '',
    ua: (req.headers.get('user-agent') || '').slice(0, 400),
  };
}
function sameOrigin(req) {
  const o = req.headers.get('origin');
  if (!o) return req.headers.get('sec-fetch-site') === 'same-origin';
  return o === new URL(req.url).origin;
}
function getCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
const SID = '__Host-sdal_admin';

/* ---------------- Worker ---------------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const store = env.AUDIT.get(env.AUDIT.idFromName('main'));

    if (url.pathname === '/api/log') {
      if (req.method !== 'POST') return json({ error: 'method' }, 405);
      if (!sameOrigin(req)) return json({ error: 'origin' }, 403);
      let body;
      try { const t = await req.text(); if (t.length > 4096) throw 0; body = JSON.parse(t); } catch { return json({ error: 'body' }, 400); }
      if (!EVENT_TYPES.has(body.type)) return json({ error: 'type' }, 400);
      const r = await store.log({
        ...clientInfo(req), type: body.type,
        visitor: String(body.visitor || '').slice(0, 40), session: String(body.session || '').slice(0, 40),
        detail: JSON.stringify(body.detail ?? {}).slice(0, 2000),
      });
      return json(r, r.ok ? 200 : 429);
    }

    if (url.pathname.startsWith('/api/admin/')) {
      const res = await handleAdmin(req, url, env, store);
      Object.entries(ADMIN_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (url.pathname === '/admin') return Response.redirect(url.origin + '/admin/', 301);
      const r = await env.ASSETS.fetch(req);
      const res = new Response(r.body, r);
      Object.entries(ADMIN_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    return env.ASSETS.fetch(req);
  },
};

async function handleAdmin(req, url, env, store) {
  const info = clientInfo(req);
  const route = url.pathname.slice('/api/admin/'.length);

  if (req.method === 'POST' && !sameOrigin(req)) return json({ error: 'origin' }, 403);

  if (route === 'login' && req.method === 'POST') {
    if (!env.ADMIN_KEY_HASH) return json({ error: 'Clé d’administration non configurée.' }, 500);
    const lock = await store.checkLock(info.ip);
    if (lock.locked) return json({ error: `Trop de tentatives. Réessayez dans ${Math.ceil(lock.wait / 60000)} min.` }, 429);
    let key = '';
    try { key = String((await req.json()).key || ''); } catch {}
    // délai fixe pour lisser les temps de réponse
    await new Promise(r => setTimeout(r, 400));
    const ok = key.length >= 32 && key.length <= 256 && safeEqual(await sha256hex(key), env.ADMIN_KEY_HASH.toLowerCase());
    if (!ok) {
      await store.fail(info);
      return json({ error: 'Clé invalide.' }, 401);
    }
    const sid = randomToken(32);
    await store.createSession(sid, info);
    return json({ ok: true }, 200, {
      'set-cookie': `${SID}=${sid}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
    });
  }

  const sid = getCookie(req, SID);
  const session = sid ? await store.getSession(sid, info) : null;
  if (!session) return json({ error: 'auth' }, 401);

  if (route === 'logout' && req.method === 'POST') {
    await store.deleteSession(sid, info);
    return json({ ok: true }, 200, { 'set-cookie': `${SID}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
  }
  if (route === 'me') return json({ ok: true, expires: session.expires });
  if (route === 'stats') return json(await store.stats());
  if (route === 'events') return json(await store.events(Object.fromEntries(url.searchParams)));
  if (route === 'sessions') return json(await store.sessions(Object.fromEntries(url.searchParams)));
  if (route === 'export.csv') {
    const rows = await store.events({ ...Object.fromEntries(url.searchParams), limit: '50000', offset: '0' });
    const cols = ['ts', 'ip', 'country', 'city', 'asn', 'type', 'detail', 'visitor', 'session', 'ua'];
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = '﻿' + cols.join(';') + '\n' + rows.items.map(r => cols.map(c => q(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(';')).join('\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="registre_sdal_${new Date().toISOString().slice(0, 10)}.csv"` } });
  }
  return json({ error: 'not found' }, 404);
}

/* ---------------- Stockage (Durable Object SQLite) ---------------- */
export class AuditLog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ip TEXT, country TEXT, city TEXT, asn TEXT,
        ua TEXT, visitor TEXT, session TEXT, type TEXT NOT NULL, detail TEXT);
      CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS ev_session ON events(session);
      CREATE INDEX IF NOT EXISTS ev_ip ON events(ip);
      CREATE TABLE IF NOT EXISTS admin_sessions (id_hash TEXT PRIMARY KEY, ua_hash TEXT, ip TEXT, created INTEGER, expires INTEGER);
      CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, n INTEGER, first INTEGER, until INTEGER);
    `);
    this.rate = new Map();
  }

  _insert(e) {
    this.sql.exec(`INSERT INTO events (ts, ip, country, city, asn, ua, visitor, session, type, detail) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      Date.now(), e.ip, e.country, e.city, e.asn, e.ua, e.visitor || '', e.session || '', e.type, e.detail || '{}');
  }

  async log(e) {
    const now = Date.now(), minute = Math.floor(now / 60000);
    const r = this.rate.get(e.ip);
    if (r && r.m === minute) { if (++r.n > LOG_RATE_PER_MIN) return { ok: false }; }
    else this.rate.set(e.ip, { m: minute, n: 1 });
    if (this.rate.size > 5000) this.rate.clear();
    this._insert(e);
    if (Math.random() < 0.01) this._prune();
    return { ok: true };
  }

  _prune() {
    const now = Date.now();
    this.sql.exec('DELETE FROM events WHERE ts < ?', now - RETENTION_DAYS * 86400000);
    this.sql.exec('DELETE FROM admin_sessions WHERE expires < ?', now);
    this.sql.exec('DELETE FROM fails WHERE until < ? AND first < ?', now, now - 3600000);
  }

  async checkLock(ip) {
    const now = Date.now();
    const row = this.sql.exec('SELECT until FROM fails WHERE ip = ?', ip).toArray()[0];
    if (row && row.until > now) return { locked: true, wait: row.until - now };
    const g = this.sql.exec('SELECT COALESCE(SUM(n),0) AS t FROM fails WHERE first > ?', now - 3600000).one().t;
    if (g >= MAX_FAILS_GLOBAL) return { locked: true, wait: LOCK_MS };
    return { locked: false };
  }

  async fail(info) {
    const now = Date.now();
    const row = this.sql.exec('SELECT n, first FROM fails WHERE ip = ?', info.ip).toArray()[0];
    let n = 1, first = now;
    if (row && now - row.first < 3600000) { n = row.n + 1; first = row.first; }
    const until = n >= MAX_FAILS_IP ? now + LOCK_MS : 0;
    this.sql.exec('INSERT OR REPLACE INTO fails (ip, n, first, until) VALUES (?,?,?,?)', info.ip, n, first, until);
    this._insert({ ...info, type: 'admin_login_fail', detail: JSON.stringify({ tentative: n, verrouille: !!until }) });
  }

  async createSession(sid, info) {
    const now = Date.now();
    this.sql.exec('DELETE FROM fails WHERE ip = ?', info.ip);
    this.sql.exec('INSERT INTO admin_sessions (id_hash, ua_hash, ip, created, expires) VALUES (?,?,?,?,?)',
      await sha256hex(sid), await sha256hex(info.ua), info.ip, now, now + SESSION_TTL);
    this._insert({ ...info, type: 'admin_login', detail: '{}' });
  }

  async getSession(sid, info) {
    const row = this.sql.exec('SELECT * FROM admin_sessions WHERE id_hash = ?', await sha256hex(sid)).toArray()[0];
    if (!row || row.expires < Date.now()) return null;
    if (row.ua_hash !== await sha256hex(info.ua)) return null;
    return row;
  }

  async deleteSession(sid, info) {
    this.sql.exec('DELETE FROM admin_sessions WHERE id_hash = ?', await sha256hex(sid));
    this._insert({ ...info, type: 'admin_logout', detail: '{}' });
  }

  _where(p) {
    const w = [], a = [];
    if (p.from) { w.push('ts >= ?'); a.push(Date.parse(p.from)); }
    if (p.to) { w.push('ts < ?'); a.push(Date.parse(p.to) + 86400000); }
    if (p.type) { w.push('type = ?'); a.push(p.type); }
    if (p.ip) { w.push('ip = ?'); a.push(p.ip); }
    if (p.session) { w.push('session = ?'); a.push(p.session); }
    if (p.q) { w.push('(detail LIKE ? OR ua LIKE ? OR city LIKE ? OR asn LIKE ?)'); const l = `%${p.q}%`; a.push(l, l, l, l); }
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
  }

  async events(p) {
    const { sql, args } = this._where(p);
    const limit = Math.min(50000, Math.max(1, +p.limit || 100)), offset = Math.max(0, +p.offset || 0);
    const total = this.sql.exec(`SELECT COUNT(*) AS n FROM events ${sql}`, ...args).one().n;
    const items = this.sql.exec(`SELECT * FROM events ${sql} ORDER BY ts DESC LIMIT ? OFFSET ?`, ...args, limit, offset).toArray();
    return { total, items };
  }

  async sessions(p) {
    const { sql, args } = this._where({ ...p, type: '' });
    const limit = Math.min(500, Math.max(1, +p.limit || 100)), offset = Math.max(0, +p.offset || 0);
    const base = `FROM events ${sql ? sql + ' AND' : 'WHERE'} session <> ''`;
    const total = this.sql.exec(`SELECT COUNT(DISTINCT session) AS n ${base}`, ...args).one().n;
    const items = this.sql.exec(`
      SELECT session, MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n, MAX(ip) AS ip, MAX(country) AS country, MAX(city) AS city,
             MAX(asn) AS asn, MAX(ua) AS ua, MAX(visitor) AS visitor,
             SUM(type = 'detail_open') AS details, SUM(type = 'batch_start') AS batches, SUM(type = 'links_export') AS links
      ${base} GROUP BY session ORDER BY last DESC LIMIT ? OFFSET ?`, ...args, limit, offset).toArray();
    return { total, items };
  }

  async stats() {
    const now = Date.now(), d1 = now - 86400000, d7 = now - 7 * 86400000, d30 = now - 30 * 86400000;
    const one = (q, ...a) => this.sql.exec(q, ...a).one();
    return {
      visits24h: one(`SELECT COUNT(*) AS n FROM events WHERE type='visit' AND ts>?`, d1).n,
      visits7d: one(`SELECT COUNT(*) AS n FROM events WHERE type='visit' AND ts>?`, d7).n,
      ips30d: one(`SELECT COUNT(DISTINCT ip) AS n FROM events WHERE ts>?`, d30).n,
      visitors30d: one(`SELECT COUNT(DISTINCT visitor) AS n FROM events WHERE ts>? AND visitor<>''`, d30).n,
      batches30d: one(`SELECT COUNT(*) AS n FROM events WHERE type='batch_start' AND ts>?`, d30).n,
      fails24h: one(`SELECT COUNT(*) AS n FROM events WHERE type='admin_login_fail' AND ts>?`, d1).n,
      total: one(`SELECT COUNT(*) AS n FROM events`).n,
      topIps: this.sql.exec(`SELECT ip, MAX(country) AS country, COUNT(*) AS n FROM events WHERE ts>? GROUP BY ip ORDER BY n DESC LIMIT 10`, d30).toArray(),
      types: this.sql.exec(`SELECT type, COUNT(*) AS n FROM events WHERE ts>? GROUP BY type ORDER BY n DESC`, d30).toArray(),
    };
  }
}
