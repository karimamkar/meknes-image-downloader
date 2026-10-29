/* Guide pas à pas : met en évidence un élément et explique son rôle.
   Tour.run(id, steps, { force }) — chaque guide n'est affiché automatiquement qu'une fois (mémorisé). */
(() => {
'use strict';
const KEY = id => 'sig.tour.' + id + '.v2';
const seen = id => { try { return !!localStorage.getItem(KEY(id)); } catch { return false; } };
const mark = id => { try { localStorage.setItem(KEY(id), '1'); } catch {} };
let active = null;

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function build(root) {
  const wrap = document.createElement('div');
  wrap.className = 'tour';
  wrap.innerHTML = `<div class="tour-shade"></div><div class="tour-spot"></div>
    <div class="tour-pop" role="dialog" aria-live="polite">
      <div class="tour-step"></div><h4 class="tour-title"></h4><div class="tour-text"></div>
      <div class="tour-foot">
        <button class="tour-skip" type="button">Passer le guide</button>
        <div class="tour-dots"></div>
        <div class="tour-nav"><button class="btn small tour-prev" type="button">‹ Précédent</button>
        <button class="btn small primary tour-next" type="button">Suivant ›</button></div>
      </div></div>`;
  root.appendChild(wrap);
  return wrap;
}

function place(t) {
  const step = t.steps[t.i];
  const el = typeof step.el === 'function' ? step.el() : (step.el ? document.querySelector(step.el) : null);
  const spot = t.wrap.querySelector('.tour-spot'), pop = t.wrap.querySelector('.tour-pop'), shade = t.wrap.querySelector('.tour-shade');
  t.wrap.querySelector('.tour-step').textContent = `${t.title ? t.title + ' · ' : ''}Étape ${t.i + 1} / ${t.steps.length}`;
  t.wrap.querySelector('.tour-title').textContent = step.title;
  t.wrap.querySelector('.tour-text').innerHTML = step.text;
  t.wrap.querySelector('.tour-prev').disabled = t.i === 0;
  t.wrap.querySelector('.tour-next').textContent = t.i === t.steps.length - 1 ? 'Terminer ✓' : 'Suivant ›';
  t.wrap.querySelector('.tour-dots').innerHTML = t.steps.map((_, k) => `<i class="${k === t.i ? 'on' : ''}"></i>`).join('');
  pop.classList.toggle('wide', !!step.wide);

  if (!visible(el)) {
    spot.style.display = 'none'; shade.style.display = 'block';
    pop.className = pop.className.replace(/\bpos-\w+/g, '') + ' pos-center';
    pop.style.left = pop.style.top = '';
    return;
  }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect(), pad = 6;
  shade.style.display = 'none'; spot.style.display = 'block';
  Object.assign(spot.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  pop.className = pop.className.replace(/\bpos-\w+/g, '');
  const pw = pop.offsetWidth, ph = pop.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 14;
  let top, left, pos;
  if (r.bottom + gap + ph < vh) { top = r.bottom + gap; pos = 'bottom'; }
  else if (r.top - gap - ph > 0) { top = r.top - gap - ph; pos = 'top'; }
  else { top = Math.max(12, Math.min(vh - ph - 12, r.top + r.height / 2 - ph / 2)); pos = r.left > vw / 2 ? 'left' : 'right'; }
  if (pos === 'left') left = r.left - gap - pw;
  else if (pos === 'right') left = r.right + gap;
  else left = r.left + r.width / 2 - pw / 2;
  left = Math.max(12, Math.min(vw - pw - 12, left));
  if (pos === 'left' && left + pw > r.left) left = Math.max(12, r.left - pw - gap);
  pop.classList.add('pos-' + pos);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.style.setProperty('--arrow-x', Math.max(16, Math.min(pw - 16, r.left + r.width / 2 - left)) + 'px');
}

function go(d) {
  const t = active; if (!t) return;
  const n = t.i + d;
  if (n < 0) return;
  if (n >= t.steps.length) return close();
  t.i = n;
  const s = t.steps[t.i];
  if (s.before) s.before();
  setTimeout(() => active === t && place(t), s.before ? 250 : 0);
}

function close() {
  const t = active; if (!t) return;
  mark(t.id); t.wrap.remove(); active = null;
  removeEventListener('resize', onResize); removeEventListener('keydown', onKey, true);
  t.onClose?.();
}
const onResize = () => active && place(active);
function onKey(ev) {
  if (!active) return;
  if (ev.key === 'ArrowRight' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); go(1); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); ev.stopPropagation(); go(-1); }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
}

window.Tour = {
  seen,
  isActive: () => !!active,
  run(id, steps, opts = {}) {
    if (!opts.force && seen(id)) return false;
    if (active) close();
    const root = document.querySelector('dialog[open]') || document.body;
    const wrap = build(root);
    active = { id, steps, i: 0, wrap, title: opts.title || '', onClose: opts.onClose };
    wrap.querySelector('.tour-next').onclick = () => go(1);
    wrap.querySelector('.tour-prev').onclick = () => go(-1);
    wrap.querySelector('.tour-skip').onclick = close;
    wrap.querySelector('.tour-shade').onclick = () => {};
    addEventListener('resize', onResize); addEventListener('keydown', onKey, true);
    if (steps[0].before) steps[0].before();
    requestAnimationFrame(() => place(active));
    return true;
  },
  close,
};
})();
