/* SIG Meknès — visualisation et téléchargement des photos (100 % navigateur) */
(() => {
'use strict';

const DEFAULT_BASE = 'https://streetlighting-audit.lon1.digitaloceanspaces.com/';
const SAMPLE = { armoires: 'data/sample_armoires.xlsx', pl: 'data/sample_points_lumineux.xlsx' };
const PAGE = 100;
const PHOTO_RE = /[^\s,;]+\.(?:jpe?g|png|webp|heic)/gi;

/* Colonnes photo connues -> libellé de groupe (dossier dans le ZIP) */
const PHOTO_COLS = {
  armoires: { 'Photos extérieures': 'exterieur', 'Photos intérieures': 'interieur' },
  pl: { 'photo_poin': 'point', 'photos_lum': 'luminaire', 'photo_pied': 'pied' },
};
/* Colonnes affichées dans la liste */
const LIST_COLS = {
  armoires: [['Armoire FID','FID'],['Code','Code'],['Source','Source'],['Etat enveloppe','État env.'],['Nombre depart','Départs']],
  pl: [['fid','FID'],['Armoire_FID','Armoire'],['Localisation','Localisation'],['Nom_modele_luminaire 1','Modèle'],['Puissance_Luminaire 1','P (W)'],['Hauteur_support','H (m)']],
};

const S = {
  type: 'armoires', view: 'list', page: 0,
  data: { armoires: [], pl: [] }, filtered: [],
  base: load('base', DEFAULT_BASE), conc: +load('conc', 6),
  map: null, cluster: null, mapDirty: true, current: null, lb: { list: [], i: 0 }, abort: null,
};

const $ = s => document.querySelector(s);
function load(k, d) { try { return localStorage.getItem('sig.' + k) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('sig.' + k, v); } catch {} }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const empty = v => v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim());

function photoUrl(file) {
  const b = S.base.trim();
  return b.includes('{file}') ? b.replace('{file}', encodeURIComponent(file)) : b.replace(/\/?$/, '/') + encodeURIComponent(file);
}

/* ---------- Lecture et normalisation ---------- */
function splitPhotos(v) { return empty(v) ? [] : (String(v).match(PHOTO_RE) || []); }

function normalize(type, rows) {
  const known = PHOTO_COLS[type];
  return rows.map(r => {
    const photos = [];
    const seen = new Set();
    const add = (group, col) => splitPhotos(r[col]).forEach(f => {
      if (seen.has(f)) return; seen.add(f);
      photos.push({ group, col, file: f });
    });
    Object.entries(known).forEach(([col, g]) => add(g, col));
    // Photos présentes dans d'autres colonnes (décalage de saisie, etc.)
    Object.keys(r).forEach(col => { if (!known[col]) add('autres', col); });
    const id = type === 'armoires' ? r['Armoire FID'] : r['fid'];
    const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
    const label = type === 'armoires'
      ? `Armoire ${id}${empty(r.Code) ? '' : ' — ' + String(r.Code).trim()}`
      : `PL ${id}${empty(r.Localisation) ? '' : ' — ' + r.Localisation}`;
    const armoire = type === 'armoires' ? id : r['Armoire_FID'];
    const text = Object.values(r).filter(v => !empty(v) && typeof v !== 'object').join(' ').toLowerCase();
    return { type, id, lat, lng, label, armoire, photos, raw: r, text };
  });
}

async function readWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true });
}

async function loadSample() {
  try {
    const [a, p] = await Promise.all(Object.values(SAMPLE).map(u => fetch(u).then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })));
    setData('armoires', await readWorkbook(a));
    setData('pl', await readWorkbook(p));
    toast('Extrait chargé. Chargez les fichiers complets dans ⚙ Paramètres.');
  } catch {
    toast('Aucun fichier chargé : ouvrez ⚙ Paramètres pour charger les Excel.');
  }
}

function setData(type, rows) {
  S.data[type] = normalize(type, rows);
  $('#cnt-' + type).textContent = S.data[type].length.toLocaleString('fr');
  if (type === 'armoires') fillArmoireFilter();
  S.mapDirty = true; S.page = 0; apply();
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
    (!arm || String(e.armoire) === arm) &&
    (!onlyPh || e.photos.length) &&
    (!q || e.text.includes(q)));
  const n = S.filtered.reduce((s, e) => s + e.photos.length, 0);
  $('#summary').textContent = `${S.filtered.length.toLocaleString('fr')} éléments · ${n.toLocaleString('fr')} photos`;
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
    `<tr data-i="${S.page * PAGE + i}">` +
    cols.map(c => `<td>${esc(e.raw[c[0]])}</td>`).join('') +
    `<td><span class="badge">${e.photos.length}</span></td>` +
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

const iconArm = L => L.divIcon({ className: 'mk-arm', iconSize: [12, 12] });
const iconPl = L => L.divIcon({ className: '', html: '<div style="width:10px;height:10px;border-radius:50%;background:#0b6bcb;border:2px solid #fff;box-shadow:0 0 2px #000"></div>', iconSize: [14, 14] });

function renderMap() {
  if (!S.map) initMap();
  setTimeout(() => S.map.invalidateSize(), 0);
  if (!S.mapDirty) return;
  S.mapDirty = false;
  S.cluster.clearLayers();
  const icon = S.type === 'armoires' ? iconArm(L) : iconPl(L);
  const markers = [];
  S.filtered.forEach((e, i) => {
    if (!isFinite(e.lat) || !isFinite(e.lng)) return;
    const m = L.marker([e.lat, e.lng], { icon });
    m.bindPopup(() => popupHtml(e, i), { minWidth: 220 });
    markers.push(m);
  });
  S.cluster.addLayers(markers);
  if (markers.length) S.map.fitBounds(S.cluster.getBounds(), { maxZoom: 18, padding: [20, 20] });
}

function popupHtml(e, i) {
  return `<b>${esc(e.label)}</b><br><span class="muted">${e.photos.length} photo(s)</span>
    <div class="popup-thumbs">${e.photos.slice(0, 3).map(p => `<img src="${esc(photoUrl(p.file))}" alt="">`).join('')}</div>
    <button class="small primary" onclick="window.__open(${i})">Voir le détail</button>`;
}

/* ---------- Détail ---------- */
function openDetail(i) {
  const e = S.filtered[i]; if (!e) return;
  S.current = e;
  $('#d-title').textContent = e.label;
  const groups = {};
  e.photos.forEach(p => (groups[p.group] ??= []).push(p));
  let html = '';
  Object.entries(groups).forEach(([g, list]) => {
    html += `<div class="group"><h3>${esc(g)} (${list.length})</h3><div class="gallery">` +
      list.map(p => {
        const u = photoUrl(p.file), k = e.photos.indexOf(p);
        return `<div class="ph"><img loading="lazy" src="${esc(u)}" data-k="${k}" alt="${esc(p.file)}" title="${esc(p.file)}"
          onerror="this.outerHTML='<div class=err>Image indisponible<br>${esc(p.file)}</div>'">
          <a href="${esc(u)}" target="_blank" rel="noopener" download="${esc(p.file)}">⤓</a></div>`;
      }).join('') + '</div></div>';
  });
  if (!e.photos.length) html += '<p class="muted">Aucune photo pour cet élément.</p>';
  if (e.type === 'pl' && e.armoire != null) html += `<p><button class="small ghost" id="d-goto-arm">Voir l'armoire ${esc(e.armoire)}</button></p>`;
  if (e.type === 'armoires') {
    const n = S.data.pl.filter(p => String(p.armoire) === String(e.id)).length;
    if (n) html += `<p><button class="small ghost" id="d-goto-pl">Voir les ${n} points lumineux de cette armoire</button></p>`;
  }
  const attrs = Object.entries(e.raw).filter(([k, v]) => !empty(v) && !splitPhotos(v).length);
  html += `<div class="group"><h3>Attributs</h3><dl class="attrs">${attrs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
  $('#d-body').innerHTML = html;
  $('#d-body').scrollTop = 0;
  $('#detail').classList.remove('hidden');
  $('#d-goto-arm')?.addEventListener('click', () => gotoArmoire(e.armoire));
  $('#d-goto-pl')?.addEventListener('click', () => gotoPlOf(e.id));
}
window.__open = openDetail;

function gotoArmoire(id) {
  setType('armoires'); $('#f-armoire').value = ''; $('#q').value = ''; apply();
  const i = S.filtered.findIndex(a => String(a.id) === String(id));
  i >= 0 ? openDetail(i) : toast(`Armoire ${id} absente du fichier chargé.`);
}
function gotoPlOf(id) {
  $('#detail').classList.add('hidden');
  $('#f-armoire').value = String(id); $('#q').value = ''; setType('pl');
}

/* ---------- Visionneuse ---------- */
function lightbox(list, i) {
  S.lb = { list, i };
  $('#lightbox').classList.remove('hidden');
  showLb();
}
function showLb() {
  const { list, i } = S.lb, p = list[i];
  $('#lb-img').src = photoUrl(p.file);
  $('#lb-cap').textContent = `${p.group} · ${p.file} (${i + 1}/${list.length})`;
}
function stepLb(d) { S.lb.i = (S.lb.i + d + S.lb.list.length) % S.lb.list.length; showLb(); }

/* ---------- Téléchargements ---------- */
function zipPath(e, p) {
  return e.type === 'armoires'
    ? `armoires/${e.id}/${p.group}/${p.file}`
    : `points_lumineux/armoire_${e.armoire ?? 'sans'}/PL_${e.id}/${p.group}/${p.file}`;
}
function jobs(elements) {
  return elements.flatMap(e => e.photos.map(p => ({ url: photoUrl(p.file), path: zipPath(e, p) })));
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const prefix = () => (S.type === 'armoires' ? 'armoires' : 'points_lumineux') + ($('#f-armoire').value ? '_A' + $('#f-armoire').value : '');

function exportLinks() {
  const j = jobs(S.filtered); if (!j.length) return toast('Aucune photo dans la sélection.');
  saveBlob(new Blob([j.map(x => x.url).join('\n') + '\n'], { type: 'text/plain' }), `${prefix()}_liens_${stamp()}.txt`);
}

function exportScript() {
  const j = jobs(S.filtered); if (!j.length) return toast('Aucune photo dans la sélection.');
  const lines = j.map(x => `@('${x.url.replace(/'/g, "''")}','${x.path.replace(/\//g, '\\').replace(/'/g, "''")}')`);
  const ps = `# Téléchargement des photos SIG Meknès — ${j.length} fichiers
# Exécution : clic droit > "Exécuter avec PowerShell" (ou: powershell -ExecutionPolicy Bypass -File script.ps1)
$ErrorActionPreference = 'Continue'
$root = Join-Path $PSScriptRoot 'photos_sig'
$files = @(
  ${lines.join(',\n  ')}
)
$i = 0; $ko = 0
foreach ($f in $files) {
  $i++
  $dest = Join-Path $root $f[1]
  if (Test-Path $dest) { continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Write-Progress -Activity 'Photos SIG' -Status "$i / $($files.Count)" -PercentComplete ($i * 100 / $files.Count)
  try { Invoke-WebRequest -Uri $f[0] -OutFile $dest -UseBasicParsing -TimeoutSec 60 }
  catch { $ko++; Add-Content (Join-Path $root 'erreurs.txt') "$($f[0])\`t$($_.Exception.Message)" }
}
Write-Host "Terminé : $($files.Count - $ko) OK, $ko erreur(s). Dossier : $root"
`;
  saveBlob(new Blob(['\ufeff' + ps], { type: 'text/plain' }), `${prefix()}_telechargement_${stamp()}.ps1`);
}

async function downloadZip(elements, name) {
  const j = jobs(elements); if (!j.length) return toast('Aucune photo dans la sélection.');
  if (j.length > 3000 && !confirm(`${j.length} photos : le ZIP est construit en mémoire et peut saturer le navigateur. Filtrez par armoire ou utilisez le script PowerShell.\n\nContinuer quand même ?`)) return;
  const zip = new JSZip(); const errors = [];
  const ctl = new AbortController(); S.abort = ctl;
  let done = 0, corsBlocked = false;
  progress(0, j.length);
  const worker = async () => {
    while (j.length && !ctl.signal.aborted) {
      const x = j.shift();
      try {
        const r = await fetch(x.url, { signal: ctl.signal, mode: 'cors' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        zip.file(x.path, await r.blob());
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (err instanceof TypeError && done === 0 && !zip.files[x.path]) corsBlocked = true;
        errors.push(`${x.url}\t${err.message}`);
      }
      done++; progress(done, done + j.length);
      if (corsBlocked && done >= Math.min(S.conc, 3) && !Object.keys(zip.files).length) { ctl.abort(); return; }
    }
  };
  await Promise.all(Array.from({ length: S.conc }, worker));
  if (corsBlocked && !Object.keys(zip.files).length) {
    hideProgress();
    return toast('Le serveur d’images bloque le téléchargement direct (CORS). Utilisez le script PowerShell, ou activez CORS sur le bucket (voir README).', 9000);
  }
  if (ctl.signal.aborted) { hideProgress(); return toast('Téléchargement annulé.'); }
  if (errors.length) zip.file('erreurs.txt', errors.join('\n'));
  $('#progress span').textContent = 'Compression…';
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  hideProgress();
  saveBlob(blob, name);
  toast(`ZIP prêt : ${done - errors.length} photo(s)${errors.length ? `, ${errors.length} erreur(s) (voir erreurs.txt)` : ''}.`);
}

function progress(d, t) {
  $('#progress').classList.remove('hidden');
  $('#progress i').style.width = (t ? d * 100 / t : 0) + '%';
  $('#progress span').textContent = `${d} / ${t}`;
}
function hideProgress() { $('#progress').classList.add('hidden'); S.abort = null; }

let toastT;
function toast(msg, ms = 4000) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- Événements ---------- */
function setType(t) {
  S.type = t; S.page = 0;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.type === t));
  apply();
}

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
document.querySelectorAll('.view').forEach(b => b.addEventListener('click', () => {
  S.view = b.dataset.view;
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x === b));
  $('#list-view').classList.toggle('hidden', S.view !== 'list');
  $('#map-view').classList.toggle('hidden', S.view !== 'map');
  render();
}));
let qT; $('#q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(() => { S.page = 0; apply(); }, 200); });
$('#f-armoire').addEventListener('change', () => { S.page = 0; apply(); });
$('#f-photos').addEventListener('change', () => { S.page = 0; apply(); });
$('#tbl tbody').addEventListener('click', ev => { const tr = ev.target.closest('tr[data-i]'); if (tr) openDetail(+tr.dataset.i); });
$('#pager').addEventListener('click', ev => { const b = ev.target.closest('[data-p]'); if (b) { S.page = +b.dataset.p; renderList(); $('#list-view').scrollTop = 0; } });
$('#d-close').addEventListener('click', () => $('#detail').classList.add('hidden'));
$('#d-body').addEventListener('click', ev => { const img = ev.target.closest('img[data-k]'); if (img) lightbox(S.current.photos, +img.dataset.k); });
$('#d-zip').addEventListener('click', () => S.current && downloadZip([S.current], `${S.current.type === 'armoires' ? 'armoire' : 'PL'}_${S.current.id}.zip`));
$('#lb-prev').addEventListener('click', () => stepLb(-1));
$('#lb-next').addEventListener('click', () => stepLb(1));
$('#lb-close').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
document.addEventListener('keydown', ev => {
  if ($('#lightbox').classList.contains('hidden')) { if (ev.key === 'Escape') $('#detail').classList.add('hidden'); return; }
  if (ev.key === 'Escape') $('#lightbox').classList.add('hidden');
  if (ev.key === 'ArrowLeft') stepLb(-1);
  if (ev.key === 'ArrowRight') stepLb(1);
});
$('#btn-links').addEventListener('click', exportLinks);
$('#btn-script').addEventListener('click', exportScript);
$('#btn-zip').addEventListener('click', () => downloadZip(S.filtered, `${prefix()}_photos_${stamp()}.zip`));
$('#p-cancel').addEventListener('click', () => S.abort?.abort());

$('#btn-settings').addEventListener('click', () => { $('#s-base').value = S.base; $('#s-conc').value = S.conc; $('#settings').showModal(); });
$('#settings').addEventListener('close', () => {
  S.base = $('#s-base').value.trim() || DEFAULT_BASE; save('base', S.base);
  S.conc = Math.min(16, Math.max(1, +$('#s-conc').value || 6)); save('conc', S.conc);
  S.mapDirty = true; render();
});
[['#s-file-arm', 'armoires'], ['#s-file-pl', 'pl']].forEach(([sel, type]) =>
  $(sel).addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    toast(`Lecture de ${f.name}…`, 60000);
    await new Promise(r => setTimeout(r, 30));
    try { setData(type, await readWorkbook(await f.arrayBuffer())); toast(`${f.name} : ${S.data[type].length.toLocaleString('fr')} lignes chargées.`); }
    catch (err) { toast('Lecture impossible : ' + err.message, 8000); }
  }));

loadSample();
})();
