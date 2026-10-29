/* Registre SDAL Meknès — page d'administration */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n || 0).toLocaleString('fr');
const dt = ts => new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
const PAGE = 100;

const LABELS = {
  visit: 'Visite', type: 'Changement d’onglet', view: 'Changement de vue', search: 'Recherche',
  filter_add: 'Filtre ajouté', filter_clear: 'Filtre retiré', armoire_select: 'Sélection d’armoire',
  detail_open: 'Consultation d’une fiche', zip_element: 'ZIP d’un élément', batch_plan: 'Préparation des lots',
  batch_start: 'Téléchargement d’un lot', batch_end: 'Fin de téléchargement', links_export: 'Export des liens',
  help_open: 'Mode d’emploi', admin_login: 'Connexion admin', admin_logout: 'Déconnexion admin',
  admin_login_fail: 'Échec connexion admin',
};
const tagClass = t => t.startsWith('admin') ? 'sec' : /batch|zip|links/.test(t) ? 'dl' : '';
const S = { tab: 'events', page: 0 };

async function api(path, opts = {}) {
  const r = await fetch('/api/admin/' + path, { credentials: 'same-origin', ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401 && path !== 'login') { showLogin(); throw new Error('auth'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur ' + r.status);
  return data;
}

function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#key').value = ''; $('#key').focus(); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

$('#login-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('#login-err').textContent = ''; $('#login-btn').disabled = true;
  try {
    await api('login', { method: 'POST', body: JSON.stringify({ key: $('#key').value.trim() }) });
    $('#key').value = '';
    showApp(); await refresh();
  } catch (e) { $('#login-err').textContent = e.message; }
  $('#login-btn').disabled = false;
});
$('#logout').addEventListener('click', async () => { try { await api('logout', { method: 'POST' }); } catch {} showLogin(); });

function params(extra = {}) {
  const p = new URLSearchParams();
  const v = { from: $('#f-from').value, to: $('#f-to').value, type: S.tab === 'events' ? $('#f-type').value : '',
              ip: $('#f-ip').value.trim(), q: $('#f-q').value.trim(), ...extra };
  Object.entries(v).forEach(([k, x]) => { if (x !== '' && x != null) p.set(k, x); });
  return p.toString();
}

async function loadStats() {
  const s = await api('stats');
  $('#kpis').innerHTML = [
    ['Visites (24 h)', s.visits24h], ['Visites (7 j)', s.visits7d], ['Adresses IP (30 j)', s.ips30d],
    ['Postes distincts (30 j)', s.visitors30d], ['Lots téléchargés (30 j)', s.batches30d],
    ['Échecs connexion admin (24 h)', s.fails24h, s.fails24h > 0], ['Opérations enregistrées', s.total],
  ].map(([l, n, a]) => `<div class="kpi${a ? ' alert' : ''}"><b>${fmt(n)}</b><span>${l}</span></div>`).join('');
  const sel = $('#f-type'), cur = sel.value;
  const types = Object.keys(LABELS);
  sel.innerHTML = '<option value="">Toutes les opérations</option>' + types.map(t => `<option value="${t}">${esc(LABELS[t])}</option>`).join('');
  sel.value = cur;
}

function fmtDetail(d) {
  try {
    const o = JSON.parse(d || '{}');
    return Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `<b>${esc(k)}</b> ${esc(v)}`).join(' · ');
  } catch { return esc(d); }
}
function where(r) { return [r.city, r.country].filter(Boolean).map(esc).join(', ') + (r.asn ? `<br><span class="muted">${esc(r.asn)}</span>` : ''); }
function shortUa(ua) {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Autre';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? ' · ' + o : ''}`;
}

async function loadTable() {
  const data = await api(`${S.tab}?${params({ limit: PAGE, offset: S.page * PAGE })}`);
  if (S.tab === 'events') {
    $('#tbl thead').innerHTML = '<tr><th>Date</th><th>Opération</th><th>Détail</th><th>IP</th><th>Localisation</th><th>Navigateur</th></tr>';
    $('#tbl tbody').innerHTML = data.items.map(r => `<tr>
      <td class="nw">${dt(r.ts)}</td>
      <td><span class="tag ${tagClass(r.type)}">${esc(LABELS[r.type] || r.type)}</span></td>
      <td class="detail">${fmtDetail(r.detail)}</td>
      <td class="nw"><a class="ip" data-ip="${esc(r.ip)}">${esc(r.ip)}</a></td>
      <td>${where(r)}</td>
      <td class="ua" title="${esc(r.ua)}">${esc(shortUa(r.ua))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune opération.</td></tr>';
  } else {
    $('#tbl thead').innerHTML = '<tr><th>Début</th><th>Dernière activité</th><th>Durée</th><th>IP</th><th>Localisation</th><th>Opérations</th><th>Fiches</th><th>Lots</th><th>Navigateur</th></tr>';
    $('#tbl tbody').innerHTML = data.items.map(r => `<tr>
      <td class="nw">${dt(r.first)}</td><td class="nw">${dt(r.last)}</td>
      <td class="nw">${Math.max(1, Math.round((r.last - r.first) / 60000))} min</td>
      <td class="nw"><a class="ip" data-ip="${esc(r.ip)}">${esc(r.ip)}</a></td>
      <td>${where(r)}</td><td>${fmt(r.n)}</td><td>${fmt(r.details)}</td><td>${fmt(r.batches)}</td>
      <td class="ua" title="${esc(r.ua)}">${esc(shortUa(r.ua))}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Aucune connexion.</td></tr>';
  }
  const pages = Math.max(1, Math.ceil(data.total / PAGE));
  $('#pager').innerHTML = `<button data-p="${S.page - 1}" ${S.page ? '' : 'disabled'}>‹</button>
    <span>Page ${S.page + 1} / ${pages} · ${fmt(data.total)} ${S.tab === 'events' ? 'opérations' : 'connexions'}</span>
    <button data-p="${S.page + 1}" ${S.page < pages - 1 ? '' : 'disabled'}>›</button>`;
}

async function refresh() { await Promise.all([loadStats(), loadTable()]); }

document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
  S.tab = b.dataset.tab; S.page = 0;
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
  $('#f-type').disabled = S.tab !== 'events';
  loadTable();
}));
let t; ['#f-from', '#f-to', '#f-type', '#f-ip', '#f-q'].forEach(s => $(s).addEventListener('input', () => {
  clearTimeout(t); t = setTimeout(() => { S.page = 0; loadTable(); }, 300);
}));
$('#f-reset').addEventListener('click', () => { ['#f-from', '#f-to', '#f-type', '#f-ip', '#f-q'].forEach(s => $(s).value = ''); S.page = 0; loadTable(); });
$('#pager').addEventListener('click', ev => { const b = ev.target.closest('[data-p]'); if (b && !b.disabled) { S.page = +b.dataset.p; loadTable(); window.scrollTo(0, 0); } });
$('#tbl').addEventListener('click', ev => { const a = ev.target.closest('a.ip'); if (a) { $('#f-ip').value = a.dataset.ip; S.page = 0; loadTable(); } });
$('#export').addEventListener('click', () => { location.href = '/api/admin/export.csv?' + params(); });

api('me').then(() => { showApp(); refresh(); }).catch(() => showLogin());
setInterval(() => { if (!$('#app').classList.contains('hidden')) loadStats().catch(() => {}); }, 60000);
})();
