/* Photothèque SIG Meknès — visualisation et téléchargement des photos (100 % navigateur) */
(() => {
'use strict';

const DEFAULT_BASE = 'https://streetlighting-audit.lon1.digitaloceanspaces.com/photos/';
const PAGE = 100;
const PHOTO_RE = /[^\s,;]+\.(?:jpe?g|png|webp|heic)/gi;
const GB = 1024 ** 3;
const BATCH_TARGET = 1.5 * GB;            // lots visés entre 1 et 2 Go
const DEFAULT_PHOTO_SIZE = 400 * 1024;    // si la taille réelle ne peut pas être mesurée
const CLIENT_ZIP = 'https://cdn.jsdelivr.net/npm/client-zip@2.4.5/index.js';
const SHEETJS = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

const PHOTO_COLS = {
  armoires: { 'Photos extérieures': 'exterieur', 'Photos intérieures': 'interieur' },
  pl: { 'photo_poin': 'point', 'photos_lum': 'luminaire', 'photo_pied': 'pied' },
};
const LIST_COLS = {
  armoires: [['Armoire FID','FID'],['Code','Code'],['Source','Source'],['Etat enveloppe','État enveloppe'],['Nombre depart','Départs']],
  pl: [['fid','FID'],['Armoire_FID','Armoire'],['Localisation','Localisation'],['Nom_modele_luminaire 1','Modèle'],['Puissance_Luminaire 1','P (W)'],['Hauteur_support','H (m)']],
};

const S = {
  type: 'armoires', view: 'list', page: 0,
  data: { armoires: [], pl: [] }, filtered: [],
  base: load('base.v2', DEFAULT_BASE), conc: +load('conc', 6),
  map: null, cluster: null, mapDirty: true, current: null, lb: { list: [], i: 0 },
  batches: [], avgSize: null, avgMeasured: false,
};

const $ = s => document.querySelector(s);
function load(k, d) { try { return localStorage.getItem('sig.' + k) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('sig.' + k, v); } catch {} }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const empty = v => v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim());
const armKey = e => (e.armoire == null || +e.armoire === 0 || e.armoire === '') ? null : e.armoire;
const fmt = n => n.toLocaleString('fr');
const fmtSize = b => b >= GB ? (b / GB).toFixed(2).replace('.', ',') + ' Go' : Math.round(b / 1048576) + ' Mo';
const typeName = t => t === 'armoires' ? 'Armoires' : 'Points lumineux';

function photoUrl(file) {
  const b = S.base.trim();
  return b.includes('{file}') ? b.replace('{file}', encodeURIComponent(file)) : b.replace(/\/?$/, '/') + encodeURIComponent(file);
}

/* ---------- Données ---------- */
function splitPhotos(v) { return empty(v) ? [] : (String(v).match(PHOTO_RE) || []); }

function normalize(type, rows) {
  const known = PHOTO_COLS[type];
  return rows.map(r => {
    const photos = [], seen = new Set();
    const add = (group, col) => splitPhotos(r[col]).forEach(f => {
      if (seen.has(f)) return; seen.add(f);
      photos.push({ group, col, file: f });
    });
    Object.entries(known).forEach(([col, g]) => add(g, col));
    Object.keys(r).forEach(col => { if (!known[col]) add('autres', col); });
    const id = type === 'armoires' ? r['Armoire FID'] : r['fid'];
    const label = type === 'armoires'
      ? `Armoire ${id}${empty(r.Code) ? '' : ' — ' + String(r.Code).trim()}`
      : `PL ${id}${empty(r.Localisation) ? '' : ' — ' + r.Localisation}`;
    const text = Object.values(r).filter(v => !empty(v)).join(' ').toLowerCase();
    return { type, id, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude), label,
             armoire: type === 'armoires' ? id : r['Armoire_FID'], photos, raw: r, text };
  });
}

const fromColumns = d => d.rows.map(row => { const o = {}; d.cols.forEach((c, i) => { if (row[i] !== null) o[c] = row[i]; }); return o; });

async function loadData() {
  try {
    const man = await fetch('data/manifest.json').then(r => r.json());
    for (const type of ['armoires', 'pl']) {
      const parts = await Promise.all(man[type].map(f => fetch('data/' + f).then(r => { if (!r.ok) throw new Error(f); return r.json(); })));
      setData(type, parts.flatMap(fromColumns), true);
    }
  } catch (e) {
    toast('Chargement de l’inventaire impossible : ' + e.message, 8000);
  }
  $('#loading').classList.add('hidden');
}

function setData(type, rows, quiet) {
  S.data[type] = normalize(type, rows);
  $('#cnt-' + type).textContent = fmt(S.data[type].length);
  if (type === 'armoires') fillArmoireFilter();
  S.mapDirty = true; S.page = 0; S.avgSize = null;
  apply();
  if (!quiet) toast(`${typeName(type)} : ${fmt(rows.length)} lignes chargées.`);
}

function fillArmoireFilter() {
  const sel = $('#f-armoire'), v = sel.value;
  sel.innerHTML = '<option value="">Toutes les armoires</option>' +
    S.data.armoires.map(a => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
  sel.value = v;
}

/* ---------- Filtrage ---------- */
function apply() {
  const q = $('#q').value.trim().toLowerCase();
  const arm = $('#f-armoire').value;
  const onlyPh = $('#f-photos').checked;
  S.filtered = S.data[S.type].filter(e =>
    (!arm || String(e.armoire) === arm) && (!onlyPh || e.photos.length) && (!q || e.text.includes(q)));
  const n = S.filtered.reduce((s, e) => s + e.photos.length, 0);
  $('#summary').innerHTML = `<b>${fmt(S.filtered.length)}</b> éléments · <b>${fmt(n)}</b> photos`;
  S.mapDirty = true;
  render();
}
function render() { S.view === 'list' ? renderList() : renderMap(); }

/* ---------- Liste ---------- */
function renderList() {
  const cols = LIST_COLS[S.type];
  $('#tbl thead').innerHTML = '<tr>' + cols.map(c => `<th>${c[1]}</th>`).join('') + '<th>Photos</th><th>Aperçu</th></tr>';
  const pages = Math.max(1, Math.ceil(S.filtered.length / PAGE));
  S.page = Math.min(S.page, pages - 1);
  const slice = S.filtered.slice(S.page * PAGE, (S.page + 1) * PAGE);
  $('#tbl tbody').innerHTML = slice.map((e, i) =>
    `<tr data-i="${S.page * PAGE + i}">` + cols.map(c => `<td>${esc(e.raw[c[0]])}</td>`).join('') +
    `<td><span class="badge${e.photos.length ? '' : ' zero'}">${e.photos.length}</span></td>` +
    `<td class="thumbs">${e.photos.slice(0, 3).map(p => `<img loading="lazy" src="${esc(photoUrl(p.file))}" alt="" onerror="this.style.visibility='hidden'">`).join('')}</td></tr>`
  ).join('') || `<tr><td colspan="${cols.length + 2}" class="muted">Aucun élément.</td></tr>`;
  $('#pager').innerHTML = pages > 1
    ? `<button data-p="${S.page - 1}" ${S.page ? '' : 'disabled'}>‹</button><span>Page ${S.page + 1} / ${pages}</span><button data-p="${S.page + 1}" ${S.page < pages - 1 ? '' : 'disabled'}>›</button>`
    : '';
}

/* ---------- Carte ---------- */
function initMap() {
  S.map = L.map('map', { preferCanvas: true }).setView([33.89, -5.55], 13);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: '© Esri' });
  osm.addTo(S.map);
  L.control.layers({ 'Plan': osm, 'Satellite': sat }).addTo(S.map);
  S.cluster = L.markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 18, maxClusterRadius: 50 });
  S.map.addLayer(S.cluster);
}
function renderMap() {
  if (!S.map) initMap();
  setTimeout(() => S.map.invalidateSize(), 0);
  if (!S.mapDirty) return;
  S.mapDirty = false;
  S.cluster.clearLayers();
  const icon = S.type === 'armoires'
    ? L.divIcon({ className: 'mk-arm', iconSize: [13, 13] })
    : L.divIcon({ className: 'mk-pl', iconSize: [12, 12] });
  const markers = [];
  S.filtered.forEach((e, i) => {
    if (!isFinite(e.lat) || !isFinite(e.lng)) return;
    const m = L.marker([e.lat, e.lng], { icon });
    m.bindPopup(() => `<b>${esc(e.label)}</b><br><span class="muted">${e.photos.length} photo(s)</span>
      <div class="popup-thumbs">${e.photos.slice(0, 3).map(p => `<img src="${esc(photoUrl(p.file))}" alt="">`).join('')}</div>
      <button onclick="window.__open(${i})">Voir le détail</button>`, { minWidth: 220 });
    markers.push(m);
  });
  S.cluster.addLayers(markers);
  if (markers.length) S.map.fitBounds(S.cluster.getBounds(), { maxZoom: 18, padding: [20, 20] });
}

/* ---------- Détail ---------- */
function openDetail(i) {
  const e = S.filtered[i]; if (!e) return;
  S.current = e;
  $('#d-kind').textContent = e.type === 'armoires' ? 'Armoire' : 'Point lumineux';
  $('#d-title').textContent = e.label;
  const groups = {};
  e.photos.forEach(p => (groups[p.group] ??= []).push(p));
  let html = '';
  Object.entries(groups).forEach(([g, list]) => {
    html += `<div class="group"><h3>${esc(g)} · ${list.length}</h3><div class="gallery">` +
      list.map(p => {
        const u = photoUrl(p.file), k = e.photos.indexOf(p);
        return `<div class="ph"><img loading="lazy" src="${esc(u)}" data-k="${k}" alt="${esc(p.file)}" title="${esc(p.file)}"
          onerror="this.outerHTML='<div class=err>Image indisponible<br>${esc(p.file)}</div>'">
          <a href="${esc(u)}" target="_blank" rel="noopener" download="${esc(p.file)}" title="Ouvrir / télécharger">⤓</a></div>`;
      }).join('') + '</div></div>';
  });
  if (!e.photos.length) html += '<p class="muted">Aucune photo pour cet élément.</p>';
  html += '<div class="links-row">';
  if (e.type === 'pl' && armKey(e) != null) html += `<button class="btn small" id="d-goto-arm">Voir l'armoire ${esc(e.armoire)}</button>`;
  if (e.type === 'armoires') {
    const n = S.data.pl.filter(p => String(p.armoire) === String(e.id)).length;
    if (n) html += `<button class="btn small" id="d-goto-pl">Voir les ${n} points lumineux</button>`;
  }
  html += '</div>';
  const attrs = Object.entries(e.raw).filter(([, v]) => !empty(v) && !splitPhotos(v).length);
  html += `<div class="group"><h3>Attributs</h3><dl class="attrs">${attrs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
  $('#d-body').innerHTML = html;
  $('#d-body').scrollTop = 0;
  $('#detail').classList.remove('hidden');
  $('#d-goto-arm')?.addEventListener('click', () => gotoArmoire(e.armoire));
  $('#d-goto-pl')?.addEventListener('click', () => gotoPlOf(e.id));
}
window.__open = openDetail;

function gotoArmoire(id) {
  $('#f-armoire').value = ''; $('#q').value = ''; setType('armoires');
  const i = S.filtered.findIndex(a => String(a.id) === String(id));
  i >= 0 ? openDetail(i) : toast(`Armoire ${id} absente de l'inventaire.`);
}
function gotoPlOf(id) { $('#detail').classList.add('hidden'); $('#f-armoire').value = String(id); $('#q').value = ''; setType('pl'); }

/* ---------- Visionneuse ---------- */
function lightbox(list, i) { S.lb = { list, i }; $('#lightbox').classList.remove('hidden'); showLb(); }
function showLb() {
  const { list, i } = S.lb, p = list[i];
  $('#lb-img').src = photoUrl(p.file);
  $('#lb-cap').textContent = `${p.group} · ${p.file} (${i + 1}/${list.length})`;
}
function stepLb(d) { S.lb.i = (S.lb.i + d + S.lb.list.length) % S.lb.list.length; showLb(); }

/* ---------- Fichiers ---------- */
function zipPath(e, p) {
  return e.type === 'armoires'
    ? `armoires/${e.id}/${p.group}/${p.file}`
    : `points_lumineux/armoire_${armKey(e) ?? 'sans'}/PL_${e.id}/${p.group}/${p.file}`;
}
const jobs = elements => elements.flatMap(e => e.photos.map(p => ({ url: photoUrl(p.file), path: zipPath(e, p) })));
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const prefix = () => (S.type === 'armoires' ? 'armoires' : 'points_lumineux') + ($('#f-armoire').value ? '_A' + $('#f-armoire').value : '');

function exportLinks(elements = S.filtered, name = `${prefix()}_liens.txt`) {
  const j = jobs(elements); if (!j.length) return toast('Aucune photo dans la sélection.');
  saveBlob(new Blob([j.map(x => x.url).join('\n') + '\n'], { type: 'text/plain' }), name);
}

/* ---------- Lots de 1 à 2 Go ---------- */
async function measureAvgSize(elements) {
  const all = elements.flatMap(e => e.photos);
  const sample = Array.from({ length: Math.min(30, all.length) }, () => all[Math.floor(Math.random() * all.length)]);
  const sizes = (await Promise.all(sample.map(p =>
    fetch(photoUrl(p.file), { method: 'HEAD', mode: 'cors', cache: 'no-store' })
      .then(r => r.ok ? +r.headers.get('content-length') || 0 : 0).catch(() => 0)))).filter(Boolean);
  return sizes.length >= 5 ? { avg: sizes.reduce((a, b) => a + b, 0) / sizes.length, measured: true }
                           : { avg: DEFAULT_PHOTO_SIZE, measured: false };
}

function buildBatches(elements, avg) {
  const sorted = [...elements].filter(e => e.photos.length).sort((a, b) =>
    (+(armKey(a) ?? Infinity)) - (+(armKey(b) ?? Infinity)) || (+a.id || 0) - (+b.id || 0));
  const batches = []; let cur = null;
  for (const e of sorted) {
    const bytes = e.photos.length * avg;
    if (!cur || (cur.bytes + bytes > BATCH_TARGET && cur.bytes > 0)) batches.push(cur = { elements: [], photos: 0, bytes: 0 });
    cur.elements.push(e); cur.photos += e.photos.length; cur.bytes += bytes;
  }
  // un dernier lot trop petit (< 1 Go) est fusionné avec le précédent s'il reste sous 2 Go
  if (batches.length > 1) {
    const last = batches.at(-1), prev = batches.at(-2);
    if (last.bytes < GB && prev.bytes + last.bytes <= 2 * GB) {
      prev.elements.push(...last.elements); prev.photos += last.photos; prev.bytes += last.bytes; batches.pop();
    }
  }
  const p = prefix();
  batches.forEach((b, i) => {
    const arms = b.elements.map(armKey).filter(v => v != null);
    const sans = b.elements.some(e => armKey(e) == null);
    b.range = [arms.length ? (S.type === 'armoires' ? 'FID ' : 'armoires ') + `${arms[0]} → ${arms.at(-1)}` : '', sans ? 'PL sans armoire' : ''].filter(Boolean).join(' + ');
    b.name = `${p}_lot${String(i + 1).padStart(2, '0')}${batches.length > 1 ? '' : '_complet'}.zip`;
    b.state = 'todo';
  });
  return batches;
}

async function openBatches() {
  if (!S.filtered.some(e => e.photos.length)) return toast('Aucune photo dans la sélection.');
  $('#b-info').textContent = `${typeName(S.type)} · ${fmt(S.filtered.length)} éléments · mesure de la taille des photos…`;
  $('#b-list').innerHTML = '<div class="loading" style="position:static;height:120px"><div class="spinner"></div></div>';
  $('#b-note').textContent = '';
  $('#batches').showModal();
  if (!S.avgSize) { const m = await measureAvgSize(S.filtered); S.avgSize = m.avg; S.avgMeasured = m.measured; }
  S.batches = buildBatches(S.filtered, S.avgSize);
  const tot = S.batches.reduce((s, b) => s + b.bytes, 0), ph = S.batches.reduce((s, b) => s + b.photos, 0);
  $('#b-info').textContent = `${typeName(S.type)} · ${fmt(ph)} photos · ≈ ${fmtSize(tot)} · ${S.batches.length} lot(s)`;
  $('#b-note').innerHTML = (S.avgMeasured
    ? `Tailles estimées à partir d'un échantillon (≈ ${Math.round(S.avgSize / 1024)} Ko par photo). `
    : `<b>Taille réelle des photos non mesurable</b> (≈ ${Math.round(S.avgSize / 1024)} Ko par photo supposé) : les tailles de lots sont indicatives. `) +
    (window.showSaveFilePicker
      ? 'Chaque ZIP est écrit directement sur le disque à mesure du téléchargement.'
      : 'Votre navigateur construit le ZIP en mémoire : préférez Chrome ou Edge pour les lots de plus de 1 Go.');
  renderBatches();
}

function renderBatches() {
  $('#b-list').innerHTML = S.batches.map((b, i) => `
    <div class="batch ${b.state === 'done' ? 'done' : ''} ${b.state === 'err' ? 'err' : ''}" data-b="${i}">
      <div><div class="name">${esc(b.name)}</div>
        <div class="meta">${fmt(b.elements.length)} éléments · ${fmt(b.photos)} photos · ≈ ${fmtSize(b.bytes)}${b.range ? ' · ' + esc(b.range) : ''}</div></div>
      <div class="acts">
        <button class="btn small" data-act="txt">Liens .txt</button>
        <button class="btn small primary" data-act="zip">${b.state === 'run' ? 'Annuler' : b.state === 'done' ? 'Retélécharger' : '⤓ Télécharger'}</button>
      </div>
      <div class="state">${esc(b.msg || '')}</div>
      <div class="prog"><i style="width:${b.pct || 0}%"></i></div>
    </div>`).join('');
}
function updateBatch(i) {
  const b = S.batches[i], el = $(`.batch[data-b="${i}"]`); if (!el) return;
  el.querySelector('.prog i').style.width = (b.pct || 0) + '%';
  el.querySelector('.state').textContent = b.msg || '';
}

let clientZip;
async function zipToFile(list, name, onProgress, signal, preferDisk) {
  clientZip ??= await import(CLIENT_ZIP);
  const errors = []; let done = 0;
  // Récupération en parallèle, restitution dans l'ordre au générateur du ZIP
  async function* files() {
    const queue = []; let next = 0;
    const launch = () => {
      const x = list[next++];
      queue.push(fetch(x.url, { signal, mode: 'cors' })
        .then(r => r.ok ? { x, r } : (errors.push(`${x.url}\tHTTP ${r.status}`), null))
        .catch(err => { if (signal.aborted) throw err; errors.push(`${x.url}\t${err.message}`); return null; }));
    };
    while (next < list.length && queue.length < S.conc) launch();
    while (queue.length) {
      const res = await queue.shift();
      if (next < list.length) launch();
      done++; onProgress(done, list.length, errors.length);
      if (res) yield { name: res.x.path, input: res.r };
    }
    if (errors.length) yield { name: 'erreurs.txt', input: errors.join('\n') + '\n' };
  }
  const resp = clientZip.downloadZip(files());
  if (preferDisk && window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Archive ZIP', accept: { 'application/zip': ['.zip'] } }] });
    await resp.body.pipeTo(await handle.createWritable(), { signal });
  } else {
    saveBlob(await resp.blob(), name);
  }
  return { done, errors: errors.length };
}

async function runBatch(i) {
  const b = S.batches[i];
  if (b.state === 'run') { b.ctl?.abort(); return; }
  const list = jobs(b.elements);
  b.ctl = new AbortController(); b.state = 'run'; b.pct = 0; b.msg = 'Démarrage…'; renderBatches();
  try {
    const r = await zipToFile(list, b.name, (d, t, e) => {
      b.pct = d * 100 / t; b.msg = `${fmt(d)} / ${fmt(t)} photos${e ? ` · ${e} erreur(s)` : ''}`; updateBatch(i);
    }, b.ctl.signal, true);
    if (r.errors === r.done) { b.state = 'err'; b.msg = 'Aucune photo récupérée : le serveur bloque probablement le téléchargement (CORS). Utilisez « Liens .txt ».'; }
    else { b.state = 'done'; b.msg = `Terminé · ${fmt(r.done - r.errors)} photos${r.errors ? ` · ${r.errors} erreur(s) listées dans erreurs.txt` : ''}`; }
  } catch (err) {
    b.state = 'err'; b.msg = err.name === 'AbortError' ? 'Annulé.' : 'Erreur : ' + err.message;
  }
  b.pct = b.state === 'done' ? 100 : b.pct; renderBatches();
}

async function zipCurrent() {
  const e = S.current; if (!e?.photos.length) return toast('Aucune photo pour cet élément.');
  const btn = $('#d-zip'); btn.disabled = true;
  try {
    const r = await zipToFile(jobs([e]), `${e.type === 'armoires' ? 'armoire' : 'PL'}_${e.id}.zip`,
      (d, t) => { btn.textContent = `${d}/${t}`; }, new AbortController().signal, false);
    toast(r.errors === r.done ? 'Photos inaccessibles depuis le navigateur (CORS).' : `ZIP prêt${r.errors ? ` · ${r.errors} erreur(s)` : ''}.`);
  } catch (err) { toast('Erreur : ' + err.message); }
  btn.disabled = false; btn.textContent = '⤓ ZIP';
}

let toastT;
function toast(msg, ms = 4000) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- Événements ---------- */
function setType(t) {
  S.type = t; S.page = 0; S.avgSize = null;
  document.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  apply();
}
document.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  S.view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x === b));
  $('#list-view').classList.toggle('hidden', S.view !== 'list');
  $('#map-view').classList.toggle('hidden', S.view !== 'map');
  render();
}));
let qT; $('#q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(() => { S.page = 0; S.avgSize = null; apply(); }, 250); });
$('#f-armoire').addEventListener('change', () => { S.page = 0; apply(); });
$('#f-photos').addEventListener('change', () => { S.page = 0; apply(); });
$('#tbl tbody').addEventListener('click', ev => { const tr = ev.target.closest('tr[data-i]'); if (tr) openDetail(+tr.dataset.i); });
$('#pager').addEventListener('click', ev => { const b = ev.target.closest('[data-p]'); if (b) { S.page = +b.dataset.p; renderList(); $('#list-view').scrollTop = 0; } });
$('#d-close').addEventListener('click', () => $('#detail').classList.add('hidden'));
$('#d-body').addEventListener('click', ev => { const img = ev.target.closest('img[data-k]'); if (img) lightbox(S.current.photos, +img.dataset.k); });
$('#d-zip').addEventListener('click', zipCurrent);
$('#lb-prev').addEventListener('click', () => stepLb(-1));
$('#lb-next').addEventListener('click', () => stepLb(1));
$('#lb-close').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
document.addEventListener('keydown', ev => {
  if ($('#lightbox').classList.contains('hidden')) { if (ev.key === 'Escape' && !$('dialog[open]')) $('#detail').classList.add('hidden'); return; }
  if (ev.key === 'Escape') $('#lightbox').classList.add('hidden');
  if (ev.key === 'ArrowLeft') stepLb(-1);
  if (ev.key === 'ArrowRight') stepLb(1);
});
$('#btn-links').addEventListener('click', () => exportLinks());
$('#btn-zip').addEventListener('click', openBatches);
$('#b-close').addEventListener('click', () => $('#batches').close());
$('#b-list').addEventListener('click', ev => {
  const btn = ev.target.closest('[data-act]'); if (!btn) return;
  const i = +btn.closest('[data-b]').dataset.b, b = S.batches[i];
  btn.dataset.act === 'txt' ? exportLinks(b.elements, b.name.replace(/\.zip$/, '_liens.txt')) : runBatch(i);
});

$('#btn-settings').addEventListener('click', () => { $('#s-base').value = S.base; $('#s-conc').value = S.conc; $('#settings').showModal(); });
$('#settings').addEventListener('close', () => {
  S.base = $('#s-base').value.trim() || DEFAULT_BASE; save('base.v2', S.base);
  S.conc = Math.min(16, Math.max(1, +$('#s-conc').value || 6)); save('conc', S.conc);
  S.mapDirty = true; S.avgSize = null; render();
});
const loadScript = src => new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });
[['#s-file-arm', 'armoires'], ['#s-file-pl', 'pl']].forEach(([sel, type]) =>
  $(sel).addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    toast(`Lecture de ${f.name}…`, 60000);
    try {
      if (!window.XLSX) await loadScript(SHEETJS);
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      setData(type, XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true }));
    } catch (err) { toast('Lecture impossible : ' + (err.message || f.name), 8000); }
  }));

loadData();
})();
