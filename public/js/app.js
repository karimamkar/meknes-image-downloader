/* Photothèque SIG Meknès — visualisation et téléchargement des photos (100 % navigateur) */
(() => {
'use strict';

const IMAGE_BASE = 'https://streetlighting-audit.lon1.digitaloceanspaces.com/photos/';
const CONCURRENCY = 6;                    // téléchargements simultanés
const CLUSTER_UNTIL_ZOOM = 16;            // au-delà : tous les points affichés sans regroupement
const MEKNES_CENTER = [33.89, -5.55];
const PAGE = 100;
const PHOTO_RE = /[^\s,;]+\.(?:jpe?g|png|webp|heic)/gi;
const GB = 1024 ** 3;
const BATCH_TARGET = 1.5 * GB;            // lots visés entre 1 et 2 Go
const DEFAULT_PHOTO_SIZE = 400 * 1024;    // si la taille réelle ne peut pas être mesurée
const CLIENT_ZIP = 'https://cdn.jsdelivr.net/npm/client-zip@2.4.5/index.js';

const PHOTO_COLS = {
  armoires: { 'Photos extérieures': 'exterieur', 'Photos intérieures': 'interieur' },
  pl: { 'photo_poin': 'point', 'photos_lum': 'luminaire', 'photo_pied': 'pied' },
};
/* Seules ces colonnes sont affichées, filtrables et recherchables (liste, fiche, filtres). */
const LIST_COLS = {
  armoires: [['Armoire FID','FID'],['Code','Code'],['Source','Source'],['Etat enveloppe','État enveloppe'],['Nombre depart','Départs']],
  pl: [['fid','FID'],['Armoire_FID','Armoire'],['Localisation','Localisation'],['Nom_modele_luminaire 1','Modèle'],['Puissance_Luminaire 1','P (W)'],['Hauteur_support','H (m)']],
};

const S = {
  type: 'armoires', view: 'list', page: 0,
  data: { armoires: [], pl: [] }, filtered: [],
  filters: [],
  map: null, cluster: null, flat: null, markers: [], mapMode: load('mapmode', 'auto'), mapDirty: true, current: null, lb: { list: [], i: 0 },
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

const photoUrl = file => IMAGE_BASE + encodeURIComponent(file);

/* ---------- Registre des opérations (envoyé au Worker, IP relevée côté serveur) ---------- */
const rid = () => (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
const VISITOR = (() => { let v = load('visitor', ''); if (!v) { v = rid(); save('visitor', v); } return v; })();
const SESSION = (() => { try { let v = sessionStorage.getItem('sig.session'); if (!v) { v = rid(); sessionStorage.setItem('sig.session', v); } return v; } catch { return rid(); } })();
function track(type, detail = {}) {
  const body = JSON.stringify({ type, detail, visitor: VISITOR, session: SESSION });
  try { fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {}); } catch {}
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
    const text = LIST_COLS[type].map(([c]) => r[c]).filter(v => !empty(v)).join(' ').toLowerCase();
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
      setData(type, parts.flatMap(fromColumns));
    }
  } catch (e) {
    toast('Chargement de l’inventaire impossible : ' + e.message, 8000);
  }
  $('#loading').classList.add('hidden');
  setTimeout(() => Tour.run('main', TOURS.main(), { title: 'Prise en main', onClose: () => setMore(false) }), 300);
}

function setData(type, rows) {
  S.data[type] = normalize(type, rows);
  $('#cnt-' + type).textContent = fmt(S.data[type].length);
  if (type === 'armoires') fillArmoireFilter();
  S.mapDirty = true; S.page = 0; S.avgSize = null;
  apply();
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
  const fl = S.filters;
  S.filtered = S.data[S.type].filter(e =>
    (!arm || String(e.armoire) === arm) && (!onlyPh || e.photos.length) && (!q || e.text.includes(q)) &&
    fl.every(f => matchFilter(e.raw[f.col], f)));
  renderChips();
  const nf = S.filters.length + (arm ? 1 : 0) + (onlyPh ? 1 : 0);
  $('#more-count').textContent = nf ? ` · ${nf}` : '';
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
    `<tr data-i="${S.page * PAGE + i}">` + cols.map((c, k) => `<td data-label="${esc(c[1])}"${k === 0 ? ' class="key"' : ''}>${empty(e.raw[c[0]]) ? '<span class="muted">—</span>' : esc(e.raw[c[0]])}</td>`).join('') +
    `<td data-label="Photos" class="count"><span class="badge${e.photos.length ? '' : ' zero'}">${e.photos.length}</span></td>` +
    `<td class="thumbs">${e.photos.slice(0, 3).map(p => `<img loading="lazy" src="${esc(photoUrl(p.file))}" alt="" onerror="this.style.visibility='hidden'">`).join('')}</td></tr>`
  ).join('') || `<tr><td colspan="${cols.length + 2}" class="muted">Aucun élément.</td></tr>`;
  $('#pager').innerHTML = pages > 1
    ? `<button data-p="${S.page - 1}" ${S.page ? '' : 'disabled'}>‹</button><span>Page ${S.page + 1} / ${pages}</span><button data-p="${S.page + 1}" ${S.page < pages - 1 ? '' : 'disabled'}>›</button>`
    : '';
}

/* ---------- Carte ---------- */
function cityBounds() {
  // Emprise de Meknès calculée sur l'inventaire (points aberrants à plus de 0,4° du centre ignorés)
  let s = 90, w = 180, n = -90, e = -180;
  [...S.data.armoires, ...S.data.pl].forEach(p => {
    if (!isFinite(p.lat) || !isFinite(p.lng) || Math.abs(p.lat - MEKNES_CENTER[0]) > .4 || Math.abs(p.lng - MEKNES_CENTER[1]) > .4) return;
    s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng);
  });
  return s < n ? L.latLngBounds([s, w], [n, e]) : L.latLngBounds([33.80, -5.65], [33.98, -5.42]);
}

function initMap() {
  const city = cityBounds(), limit = city.pad(0.1);
  S.renderer = L.canvas({ padding: 0.3, tolerance: 4 });
  S.map = L.map('map', { renderer: S.renderer, maxBounds: limit, maxBoundsViscosity: 1, maxZoom: 20, zoomSnap: 0.5 });
  S.map.fitBounds(city);
  S.map.setMinZoom(Math.max(11, Math.floor(S.map.getBoundsZoom(city) * 2) / 2));
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, bounds: limit, attribution: '© OpenStreetMap' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, bounds: limit, attribution: '© Esri' });
  osm.addTo(S.map);
  L.control.layers({ 'Plan': osm, 'Satellite': sat }).addTo(S.map);

  S.cluster = L.markerClusterGroup({
    chunkedLoading: true, disableClusteringAtZoom: CLUSTER_UNTIL_ZOOM, maxClusterRadius: 60,
    spiderfyOnMaxZoom: false, showCoverageOnHover: false, removeOutsideVisibleBounds: true,
  });
  S.flat = L.featureGroup();

  const ModeCtl = L.Control.extend({
    onAdd() {
      const d = L.DomUtil.create('div', 'leaflet-bar map-mode');
      d.innerHTML = `<label><input type="checkbox" ${S.mapMode === 'all' ? 'checked' : ''}> Tous les points<span class="lbl-long"> (sans regroupement)</span></label>
        <small>Regroupement automatique jusqu'au zoom ${CLUSTER_UNTIL_ZOOM}</small>`;
      L.DomEvent.disableClickPropagation(d);
      d.querySelector('input').addEventListener('change', ev => { S.mapMode = ev.target.checked ? 'all' : 'auto'; save('mapmode', S.mapMode); placeMarkers(); });
      return d;
    },
  });
  new ModeCtl({ position: 'topleft' }).addTo(S.map);
}

function buildMarkers() {
  const arm = S.type === 'armoires';
  const style = arm
    ? { renderer: S.renderer, radius: 6.5, weight: 1.5, color: '#7c2d12', fillColor: '#ea580c', fillOpacity: .95 }
    : { renderer: S.renderer, radius: 4, weight: 1, color: '#155e75', fillColor: '#06b6d4', fillOpacity: .9 };
  S.markers = [];
  S.filtered.forEach((e, i) => {
    if (!isFinite(e.lat) || !isFinite(e.lng)) return;
    const m = L.circleMarker([e.lat, e.lng], style); m._i = i;
    m.on('click', ev => { L.DomEvent.stop(ev); showPopup(m); });
    S.markers.push(m);
  });
}

function placeMarkers() {
  S.cluster.clearLayers(); S.flat.clearLayers();
  S.map.removeLayer(S.cluster); S.map.removeLayer(S.flat);
  if (S.mapMode === 'all') { S.markers.forEach(m => S.flat.addLayer(m)); S.flat.addTo(S.map); }
  else { S.cluster.addLayers(S.markers); S.cluster.addTo(S.map); }
}

function showPopup(m) {
  const i = m._i, e = S.filtered[i]; if (!e) return;
  L.popup({ minWidth: 220, offset: [0, -4] }).setLatLng(m.getLatLng()).setContent(
    `<b>${esc(e.label)}</b><br><span class="muted">${e.photos.length} photo(s)</span>
     <div class="popup-thumbs">${e.photos.slice(0, 3).map(p => `<img src="${esc(photoUrl(p.file))}" alt="">`).join('')}</div>
     <button onclick="window.__open(${i})">Voir le détail</button>`).openOn(S.map);
}

function renderMap() {
  if (!S.map) initMap();
  setTimeout(() => S.map.invalidateSize(), 0);
  if (!S.mapDirty) return;
  S.mapDirty = false;
  S.map.closePopup();
  buildMarkers(); placeMarkers();
  if (S.markers.length && S.filtered.length < S.data[S.type].length) {
    S.map.fitBounds(L.latLngBounds(S.markers.map(m => m.getLatLng())), { maxZoom: 18, padding: [30, 30] });
  }
}

/* ---------- Détail ---------- */
function openDetail(i) {
  const e = S.filtered[i]; if (!e) return;
  track('detail_open', { type: e.type, id: e.id, photos: e.photos.length });
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
  html += `<div class="group"><h3>Informations</h3><dl class="attrs">${LIST_COLS[e.type].map(([c, l]) =>
    `<dt>${esc(l)}</dt><dd>${empty(e.raw[c]) ? '<span class="muted">—</span>' : esc(e.raw[c])}</dd>`).join('')}</dl></div>`;
  $('#d-body').innerHTML = html;
  $('#d-body').scrollTop = 0;
  $('#detail').classList.remove('hidden');
  $('#d-goto-arm')?.addEventListener('click', () => gotoArmoire(e.armoire));
  $('#d-goto-pl')?.addEventListener('click', () => gotoPlOf(e.id));
  if (!Tour.isActive()) setTimeout(() => Tour.run('detail', TOURS.detail(), { title: 'Fiche' }), 350);
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
// Balayage gauche/droite sur mobile
let swipeX = null;
$('#lightbox').addEventListener('touchstart', ev => { swipeX = ev.touches[0].clientX; }, { passive: true });
$('#lightbox').addEventListener('touchend', ev => {
  if (swipeX === null) return;
  const dx = ev.changedTouches[0].clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 50) stepLb(dx < 0 ? 1 : -1);
});

/* ---------- Mobile : panneau de filtres repliable ---------- */
const isMobile = () => matchMedia('(max-width: 760px)').matches;
function setMore(open) {
  $('#toolbar').classList.toggle('open', open);
  $('#btn-more').setAttribute('aria-expanded', open);
  if (S.map) setTimeout(() => S.map.invalidateSize(), 50);
}
if (isMobile()) $('#q').placeholder = 'Rechercher (FID, rue, modèle…)';
$('#btn-more').addEventListener('click', () => setMore(!$('#toolbar').classList.contains('open')));
const openMoreIfMobile = () => { if (isMobile()) setMore(true); };

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
  track('links_export', { type: S.type, fichier: name, liens: j.length });
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
  $('#b-note').classList.add('hidden');
  $('#b-title').textContent = S.type === 'armoires' ? 'Photos des armoires' : 'Photos des points lumineux';
  $('#batches').showModal();
  if (!S.avgSize) { const m = await measureAvgSize(S.filtered); S.avgSize = m.avg; S.avgMeasured = m.measured; }
  S.batches = buildBatches(S.filtered, S.avgSize);
  track('batch_plan', { type: S.type, elements: S.filtered.length, lots: S.batches.length, filtres: describeFilters() });
  const tot = S.batches.reduce((s, b) => s + b.bytes, 0), ph = S.batches.reduce((s, b) => s + b.photos, 0);
  $('#b-info').textContent = `${typeName(S.type)} · ${fmt(ph)} photos · ≈ ${fmtSize(tot)} · ${S.batches.length} lot(s)`;
  $('#b-note').textContent = window.showSaveFilePicker ? '' : 'Pour les lots de plus de 1 Go, utilisez de préférence Chrome ou Edge.';
  $('#b-note').classList.toggle('hidden', !$('#b-note').textContent);
  renderBatches();
  if (!Tour.isActive()) setTimeout(() => Tour.run('batches', TOURS.batches(), { title: 'Téléchargement' }), 200);
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
    while (next < list.length && queue.length < CONCURRENCY) launch();
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
  track('batch_start', { lot: b.name, elements: b.elements.length, photos: b.photos, taille_estimee_mo: Math.round(b.bytes / 1048576) });
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
  track('batch_end', { lot: b.name, etat: b.state, message: b.msg });
}

async function zipCurrent() {
  const e = S.current; if (!e?.photos.length) return toast('Aucune photo pour cet élément.');
  const btn = $('#d-zip'); btn.disabled = true;
  try {
    track('zip_element', { type: e.type, id: e.id, photos: e.photos.length });
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
  if (t !== S.type) track('type', { type: t });
  S.type = t; S.page = 0; S.avgSize = null; S.filters = [];
  $('#btn-zip').innerHTML = `⤓ Télécharger les photos<span class="lbl-long"> des ${t === 'armoires' ? 'armoires' : 'points lumineux'}</span>`;
  document.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  apply();
}
document.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  S.view = b.dataset.view; track('view', { vue: S.view, type: S.type });
  if (S.view === 'map' && !Tour.isActive()) setTimeout(() => Tour.run('map', TOURS.map(), { title: 'Carte' }), 900);
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x === b));
  $('#list-view').classList.toggle('hidden', S.view !== 'list');
  $('#map-view').classList.toggle('hidden', S.view !== 'map');
  render();
}));
let qT; $('#q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(() => { S.page = 0; S.avgSize = null; apply(); }, 250); clearTimeout(qT2); qT2 = setTimeout(() => { const v = $('#q').value.trim(); if (v.length >= 2) track('search', { texte: v.slice(0, 100), type: S.type, resultats: S.filtered.length }); }, 1500); });
let qT2;
$('#f-armoire').addEventListener('change', () => { S.page = 0; apply(); if ($('#f-armoire').value) track('armoire_select', { armoire: $('#f-armoire').value, type: S.type }); });
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

/* ---------- Filtres par colonne ---------- */
const OPS = { contains: 'contient', eq: 'est égal à', ne: 'est différent de', gt: 'est supérieur à', lt: 'est inférieur à', empty: 'est vide', filled: 'est renseigné' };
const colLabel = c => (LIST_COLS[S.type].find(([k]) => k === c) || [c, c])[1];
const norm = v => String(v ?? '').trim().toLowerCase();
function matchFilter(v, f) {
  const n = parseFloat(String(v).replace(',', '.')), t = parseFloat(String(f.val).replace(',', '.'));
  switch (f.op) {
    case 'contains': return norm(v).includes(norm(f.val));
    case 'eq': return norm(v) === norm(f.val);
    case 'ne': return norm(v) !== norm(f.val);
    case 'gt': return isFinite(n) && n > t;
    case 'lt': return isFinite(n) && n < t;
    case 'empty': return empty(v);
    case 'filled': return !empty(v);
  }
  return true;
}
function renderChips() {
  const box = $('#chips');
  box.classList.toggle('hidden', !S.filters.length);
  box.innerHTML = S.filters.map((f, i) =>
    `<span class="chip"><b>${esc(colLabel(f.col))}</b> ${OPS[f.op]}${['empty', 'filled'].includes(f.op) ? '' : ` « ${esc(f.val)} »`}<button data-rm="${i}" aria-label="Retirer">✕</button></span>`).join('') +
    (S.filters.length ? '<button class="link" data-rm="all">Tout effacer</button>' : '');
}
function openFilter() {
  $('#fc-col').innerHTML = LIST_COLS[S.type].map(([c, l]) => `<option value="${esc(c)}">${esc(l)}</option>`).join('');
  $('#fc-op').innerHTML = Object.entries(OPS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#fc-val').value = '';
  fillValues(); $('#fdlg').showModal();
}
function fillValues() {
  const col = $('#fc-col').value, counts = new Map();
  S.data[S.type].forEach(e => { const v = e.raw[col]; if (!empty(v)) counts.set(String(v), (counts.get(String(v)) || 0) + 1); });
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 300);
  $('#fc-values').innerHTML = top.map(([v]) => `<option value="${esc(v)}">`).join('');
  $('#fc-hint').textContent = `${fmt(counts.size)} valeur(s) distincte(s)` + (top.length ? ` · la plus fréquente : « ${top[0][0]} »` : '');
  const noVal = ['empty', 'filled'].includes($('#fc-op').value);
  $('#fc-val').disabled = noVal;
}
$('#btn-filter').addEventListener('click', openFilter);
$('#fc-col').addEventListener('change', fillValues);
$('#fc-op').addEventListener('change', fillValues);
$('#fc-cancel').addEventListener('click', () => $('#fdlg').close());
$('#fdlg form').addEventListener('submit', ev => {
  const op = $('#fc-op').value, val = $('#fc-val').value.trim();
  if (!['empty', 'filled'].includes(op) && !val) { ev.preventDefault(); $('#fc-val').focus(); return; }
  S.filters.push({ col: $('#fc-col').value, op, val });
  track('filter_add', { type: S.type, colonne: colLabel($('#fc-col').value), condition: OPS[op], valeur: val });
  S.page = 0; S.avgSize = null; apply();
});
$('#chips').addEventListener('click', ev => {
  const b = ev.target.closest('[data-rm]'); if (!b) return;
  b.dataset.rm === 'all' ? (S.filters = []) : S.filters.splice(+b.dataset.rm, 1);
  track('filter_clear', { type: S.type, restants: S.filters.length });
  S.page = 0; S.avgSize = null; apply();
});

/* ---------- Aide (premier usage) ---------- */
const describeFilters = () => [
  $('#q').value.trim() && `recherche « ${$('#q').value.trim()} »`,
  $('#f-armoire').value && `armoire ${$('#f-armoire').value}`,
  $('#f-photos').checked && 'avec photos',
  ...S.filters.map(f => `${colLabel(f.col)} ${OPS[f.op]} ${f.val}`),
].filter(Boolean).join(' ; ');

/* ---------- Guides pas à pas et directives ---------- */
const DIRECTIVES = `
  <p><b>Usage réservé</b> aux agents habilités de la SRM Fès-Meknès. Les données et photos sont à usage interne : ne pas les diffuser à des tiers. <span class="warn">Toutes les consultations et tous les téléchargements sont journalisés (date, adresse IP, poste).</span></p>
  <h4>Exploiter la base</h4>
  <ul>
    <li>Partir du bon type : <b>Armoires</b> (postes et coffrets) ou <b>Points lumineux</b> (supports et luminaires).</li>
    <li>Cibler la zone de travail : choisir une <b>armoire</b> dans la liste, ou rechercher une rue / un quartier (champ Rechercher, colonne Localisation).</li>
    <li>Affiner avec <b>Filtrer par colonne</b> : modèle, puissance, hauteur, localisation pour les points lumineux ; code, source, état de l'enveloppe, départs pour les armoires. Les filtres se cumulent.</li>
    <li>Vérifier le compteur « éléments · photos » : c'est exactement ce qui sera téléchargé.</li>
    <li>Sur la carte, cliquer un point pour ouvrir sa fiche (photos et informations) ; le lien de la fiche permet de passer d'un point lumineux à son armoire et inversement.</li>
  </ul>
  <h4>Télécharger les photos — procédure</h4>
  <ol>
    <li>Utiliser <b>Google Chrome ou Microsoft Edge</b> sur un ordinateur, avec une connexion stable.</li>
    <li>Prévoir l'espace disque : environ <b>1,5 Go par lot</b>. L'ensemble des points lumineux représente plusieurs dizaines de Go : <b>préférer un téléchargement par armoire ou par secteur</b>.</li>
    <li>Filtrer la sélection, puis cliquer <b>Télécharger les photos…</b> : la liste des lots s'affiche.</li>
    <li>Cliquer <b>Télécharger</b> sur le premier lot et choisir le dossier d'enregistrement. <b>Un lot à la fois</b>.</li>
    <li>Pendant le téléchargement : <span class="warn">ne pas fermer l'onglet, ne pas mettre l'ordinateur en veille</span>.</li>
    <li>À la fin, le lot passe en vert. Si le ZIP contient un fichier <b>erreurs.txt</b>, relancer le lot (bouton Retélécharger).</li>
    <li>Passer au lot suivant et cocher mentalement l'avancement : chaque lot indique la plage d'armoires couverte.</li>
  </ol>
  <h4>Organisation des fichiers</h4>
  <ul>
    <li>Les ZIP sont rangés par <b>armoire → point lumineux → type de photo</b> (point, luminaire, pied ; extérieur, intérieur pour les armoires).</li>
    <li><b>Ne pas renommer les photos</b> : le nom du fichier est la référence de la photo dans la base SIG.</li>
    <li>Pour quelques photos seulement : ouvrir la fiche et utiliser <b>⤓ ZIP</b> (un élément) ou l'icône ⤓ d'une photo.</li>
    <li><b>Liens (.txt)</b> fournit la liste des adresses des photos pour un gestionnaire de téléchargement (en cas de difficulté avec les ZIP).</li>
  </ul>
  <p class="muted">En cas de problème (lot en erreur répété, photo manquante), noter le nom du lot ou le FID de l'élément et le transmettre au référent SDAL.</p>`;

const TOURS = {
  main: () => [
    { title: 'Bienvenue', wide: true, text: `Cette application est la <b>photothèque du SDAL de la ville de Meknès</b> : elle permet de consulter l'inventaire de l'éclairage public (armoires et points lumineux) et de <b>télécharger les photos</b> de terrain.<br><br>Ce guide présente les boutons essentiels en quelques étapes. Il est accessible à tout moment par le bouton <b>? Guide</b>.` },
    { el: '.navbar .seg', title: 'Armoires ou points lumineux', text: 'Choisissez le type d’élément à consulter. Le nombre d’éléments est indiqué sur chaque onglet. Les filtres et le téléchargement s’appliquent au type sélectionné.' },
    { el: '.navbar .seg:nth-of-type(2)', title: 'Liste ou carte', text: 'Basculez entre le tableau et la carte de Meknès. Sur la carte, cliquez sur un point pour voir ses photos.' },
    { el: '#q', title: 'Rechercher', text: 'Recherche dans les colonnes du tableau : FID, code d’armoire, rue / localisation, modèle de luminaire…' },
    { el: '#f-armoire', before: openMoreIfMobile, title: 'Filtrer par armoire', text: 'Sélectionnez une armoire pour n’afficher que ses points lumineux. <b>C’est la meilleure façon de préparer un téléchargement par secteur.</b>' },
    { el: '#btn-filter', before: openMoreIfMobile, title: 'Filtrer par colonne', text: 'Ajoutez des conditions sur les colonnes du tableau (modèle, puissance, hauteur, localisation, code, état…). Les filtres se cumulent et s’affichent sous la barre ; un clic sur ✕ les retire.' },
    { el: '#summary', title: 'Votre sélection', text: 'Nombre d’éléments et de photos correspondant aux filtres. <b>C’est exactement ce qui sera téléchargé.</b>' },
    { el: () => S.view === 'list' ? document.querySelector('#tbl tbody tr') : null, title: 'Ouvrir une fiche', text: 'Cliquez sur une ligne pour ouvrir la fiche : photos classées par type, agrandissement plein écran, informations, lien vers l’armoire ou ses points lumineux.' },
    { el: '#btn-zip', title: 'Télécharger les photos', text: 'Prépare les photos de la sélection en <b>lots ZIP de 1 à 2 Go</b>, à télécharger un par un. Chaque ZIP est rangé par armoire puis par point lumineux.' },
    { el: '#btn-links', title: 'Liste des liens', text: 'Alternative au ZIP : un fichier texte contenant l’adresse de chaque photo de la sélection, pour un gestionnaire de téléchargement.' },
    { el: '#btn-directives', title: 'Directives SRM', text: 'Les règles d’utilisation et la procédure de téléchargement recommandée. À lire avant le premier téléchargement.' },
    { el: '#btn-help', title: 'Revoir le guide', text: 'Ce bouton relance le guide de l’écran affiché (liste, carte, fiche ou téléchargement).' },
    { title: 'Directives pour les agents SRM', wide: true, text: DIRECTIVES },
  ],
  map: () => [
    { el: '#map', title: 'Carte de Meknès', text: 'La carte est limitée à la ville. Faites glisser pour vous déplacer, molette ou boutons + / − pour zoomer. Les points sont regroupés (pastilles numérotées) aux petites échelles et tous affichés à partir du zoom 16.' },
    { el: '.map-mode', title: 'Tous les points', text: 'Cochez pour afficher chaque point individuellement, sans regroupement, quel que soit le zoom.' },
    { el: '.leaflet-control-layers', title: 'Fond de carte', text: 'Choisissez le fond <b>Plan</b> ou <b>Satellite</b>.' },
    { el: '.leaflet-control-zoom', title: 'Zoom', text: 'Zoomez sur un quartier ; cliquez une pastille de regroupement pour zoomer dessus.' },
    { title: 'Ouvrir un point', text: 'Cliquez sur un point : un aperçu des photos apparaît, avec le bouton <b>Voir le détail</b> pour ouvrir la fiche complète. Les filtres de la barre s’appliquent aussi à la carte.' },
  ],
  detail: () => [
    { el: '#d-title', title: 'Fiche de l’élément', text: 'Identifiant et localisation de l’armoire ou du point lumineux.' },
    { el: '#d-body .gallery', title: 'Photos', text: 'Photos classées par type. Cliquez une photo pour l’agrandir (flèches ← → pour naviguer) ; l’icône ⤓ l’ouvre ou la télécharge seule.' },
    { el: '#d-zip', title: 'ZIP de l’élément', text: 'Télécharge toutes les photos de cet élément dans un seul ZIP.' },
    { el: '.links-row .btn', title: 'Navigation armoire ↔ points', text: 'Passez d’un point lumineux à son armoire, ou d’une armoire à la liste de ses points lumineux.' },
    { el: () => [...document.querySelectorAll('#d-body .group h3')].find(h => h.textContent.startsWith('Informations')), title: 'Informations', text: 'Les informations principales de l’élément, identiques aux colonnes du tableau.' },
  ],
  batches: () => [
    { el: '#b-info', title: 'Contenu du téléchargement', text: 'Nombre de photos, volume estimé et nombre de lots pour la sélection en cours.' },
    { el: '.batch', title: 'Un lot = un ZIP', text: 'Chaque lot fait environ 1,5 Go. Il indique le nombre d’éléments, de photos et la plage d’armoires couverte.' },
    { el: '.batch [data-act=zip]', title: 'Télécharger un lot', text: 'Choisissez le dossier d’enregistrement : le ZIP s’écrit au fur et à mesure. <b>Un lot à la fois</b> ; ne fermez pas l’onglet pendant le téléchargement. Le lot passe en vert une fois terminé.' },
    { el: '.batch [data-act=txt]', title: 'Liens du lot', text: 'Liste des adresses des photos de ce lot, en cas de difficulté avec le ZIP.' },
    { title: 'Après le téléchargement', text: 'Si le ZIP contient un fichier <b>erreurs.txt</b>, relancez le lot. Ne renommez pas les photos : leur nom est la référence SIG.' },
  ],
};

function contextTour(force) {
  if ($('#batches').open) return Tour.run('batches', TOURS.batches(), { force, title: 'Téléchargement' });
  if (!$('#detail').classList.contains('hidden')) return Tour.run('detail', TOURS.detail(), { force, title: 'Fiche' });
  if (S.view === 'map') return Tour.run('map', TOURS.map(), { force, title: 'Carte' });
  return Tour.run('main', TOURS.main(), { force, title: 'Prise en main', onClose: () => setMore(false) });
}
$('#btn-help').addEventListener('click', () => { track('help_open', { ecran: $('#batches').open ? 'batches' : S.view }); contextTour(true); });
$('#d-help').addEventListener('click', () => Tour.run('detail', TOURS.detail(), { force: true, title: 'Fiche' }));
$('#b-help').addEventListener('click', () => Tour.run('batches', TOURS.batches(), { force: true, title: 'Téléchargement' }));
$('#directives-body').innerHTML = DIRECTIVES;
$('#btn-directives').addEventListener('click', () => { $('#directives').showModal(); track('help_open', { ecran: 'directives' }); });
$('#dir-tour').addEventListener('click', () => { $('#directives').close(); S.view === 'list' || document.querySelector('[data-view=list]').click(); Tour.run('main', TOURS.main(), { force: true, title: 'Prise en main', onClose: () => setMore(false) }); });

track('visit', { ecran: `${screen.width}x${screen.height}`, langue: navigator.language, provenance: document.referrer || '' });
loadData();
})();
