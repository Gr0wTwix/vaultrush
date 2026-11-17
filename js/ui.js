// Shared UI helpers: formatting, item art, toasts and the spinning reel.
import { RARITY } from './data.js';
import { state } from './state.js';
import { sfx } from './sfx.js';
import { itemArtSvg } from './art.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export const coin = (cls = '') => `<svg class="coin ${cls}" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#ffc53d"/><circle cx="10" cy="10" r="6.2" fill="none" stroke="#b07a00" stroke-width="1.6"/><path d="M10.8 5.5 7.5 10.6h2.6l-.9 3.9 3.3-5.1H9.9z" fill="#7a5200"/></svg>`;
export const money = (n, cls = '') => `<span class="money ${cls}">${coin()}${fmt(n)}</span>`;

/** Detailed procedural item art (see art.js). Uses `item.img` instead when an image file is provided. */
export const itemArt = item => itemArtSvg(item);

export function itemCard(item, { compact = false, extra = '', cls = '' } = {}) {
  const r = RARITY[item.rarity];
  return `<div class="item ${compact ? 'item-compact' : ''} ${cls}" style="--rc:${r.color}" title="${esc(item.weapon)} | ${esc(item.skin)}">
    <div class="item-glow"></div>
    ${item.wear ? `<span class="wear">${item.wear}</span>` : ''}
    ${itemArt(item)}
    <div class="item-meta"><div class="item-weapon">${item.st ? '<b class="st">ST</b> ' : ''}${esc(item.weapon)}</div><div class="item-skin">${esc(item.skin)}</div></div>
    <div class="item-value">${money(item.value)}</div>${extra}
  </div>`;
}

export function caseArt(c, size = '') {
  if (c.img) return `<img class="case-art case-img ${size}" src="${c.img}" alt="" loading="lazy" decoding="async">`;
  const a = `hsl(${c.hue} 90% 60%)`, b = `hsl(${c.hue} 80% 32%)`, d = `hsl(${c.hue} 70% 18%)`;
  const id = `c${c.id}${Math.random().toString(36).slice(2, 6)}`;
  return `<svg class="case-art ${size}" viewBox="0 0 120 100" aria-hidden="true"><defs>
    <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
    <radialGradient id="${id}g"><stop offset="0" stop-color="${a}" stop-opacity=".55"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="60" cy="60" rx="58" ry="40" fill="url(#${id}g)"/>
    <path d="M18 42 60 30l42 12v38L60 94 18 80z" fill="${d}"/>
    <path d="M18 42 60 54v40L18 80z" fill="url(#${id}f)"/>
    <path d="M102 42 60 54v40l42-14z" fill="${b}"/>
    <path d="M14 34 60 21l46 13-4 9-42-12-42 12z" fill="${a}"/>
    <path d="M60 54v40" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>
    <path d="M42 58 36 72h6l-3 12 11-16h-6l4-10z" fill="#fff" opacity=".9"/>
    <path d="M78 58v24M86 55v24" stroke="rgba(255,255,255,.25)" stroke-width="3"/>
  </svg>`;
}

const AV_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'];
export function avatar(name, size = 28) {
  let hsh = 0; for (const ch of name) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  const col = name === state.name ? '#c6ff3d' : AV_COLORS[Math.abs(hsh) % AV_COLORS.length];
  return `<span class="avatar" style="--av:${col};width:${size}px;height:${size}px;font-size:${size * 0.42}px">${esc(name[0].toUpperCase())}</span>`;
}

export function toast(msg, kind = 'info') {
  const el = h(`<div class="toast toast-${kind}">${msg}</div>`);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

export const ICONS = {
  home: '<path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z"/>',
  cases: '<path d="M3 8l9-4 9 4v9l-9 4-9-4zM3 8l9 4 9-4M12 12v9"/>',
  battles: '<path d="M4 4l9 9M4 4h4M4 4v4M20 4l-9 9M20 4h-4M20 4v4M7 15l-3 3 2 2 3-3M17 15l3 3-2 2-3-3"/>',
  crash: '<path d="M3 20h18M4 17c6 0 10-4 14-12M14 5h4v4"/>',
  upgrade: '<path d="M12 20V6M6 12l6-6 6 6M5 20h14"/>',
  mines: '<circle cx="12" cy="13" r="6"/><path d="M12 7V4M16 6l2-2M18 13h3M6 6 4 4M3 13h3"/>',
  fair: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  bag: '<path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  gift: '<path d="M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0"/>',
  double: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 3.5v5.5M12 15v5.5M3.5 12H9M15 12h5.5"/>',
  plinko: '<circle cx="12" cy="5" r="1.4"/><circle cx="8" cy="10" r="1.4"/><circle cx="16" cy="10" r="1.4"/><circle cx="4" cy="15" r="1.4"/><circle cx="12" cy="15" r="1.4"/><circle cx="20" cy="15" r="1.4"/><path d="M3 20h18"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5.5"/><path d="M12 9v6"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 20h8M9 17h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.5-6.5 8-6.5s7 2 8 6.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.8 3.2-5.5 6.5-5.5s5.9 1.7 6.5 5.5M16 5a3.5 3.5 0 0 1 0 6.5M18 14.8c2 .6 3.2 2.3 3.5 5.2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
  skull: '<path d="M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4.1 3 5.3V19h8v-3.7c1.8-1.2 3-2.9 3-5.3a7 7 0 0 0-7-7zM9.5 11h.01M14.5 11h.01M10 19v2M14 19v2"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12h.01"/>',
  shuffle: '<path d="M3 7h3.5c5 0 5 10 10 10H21M3 17h3.5c1.8 0 3-.8 3.9-2M21 7h-4.5c-1.8 0-3 .8-3.9 2M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/>',
  sortup: '<path d="M5 17V7M2.5 9.5 5 7l2.5 2.5M11 7h10M11 12h7M11 17h4"/>',
  sortdown: '<path d="M5 7v10M2.5 14.5 5 17l2.5-2.5M11 17h10M11 12h7M11 7h4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/**
 * Spin a reel inside `host` and stop on `winner`.
 * pool: [{item, weight}] used to fill the strip; axis: 'x' (case opening) or 'y' (battles).
 */
/** Card-less reel cell: item art floating on a rarity glow; name/value appear when it wins. */
export const bareCell = it => `<div class="reel-cell bare" style="--rc:${RARITY[it.rarity].color}"><div class="bare-glow"></div>${itemArt(it)}<div class="bare-meta"><b>${esc(it.skin)}</b>${money(it.value)}</div></div>`;

export function spinReel(host, pool, winner, { axis = 'x', duration = 5200, total = 56, winIndex = 46, sound = true, bare = true } = {}) {
  const fillers = () => {
    const sum = pool.reduce((s, e) => s + e.weight, 0);
    let x = Math.random() * sum;
    for (const e of pool) { if ((x -= e.weight) < 0) return e.item; }
    return pool[0].item;
  };
  const list = Array.from({ length: total }, (_, i) => (i === winIndex ? winner : fillers()));
  // Near-miss tease: put a high-value item right next to the winner sometimes.
  if (Math.random() < 0.45 && pool.length > 1) list[winIndex + (Math.random() < 0.5 ? 1 : -1)] = pool[0].item;

  host.innerHTML = `<div class="reel-strip">${list.map(it => (bare ? bareCell(it) : `<div class="reel-cell">${itemCard(it, { compact: true })}</div>`)).join('')}</div><div class="reel-marker"></div>`;
  host.classList.add('reel', axis === 'y' ? 'reel-y' : 'reel-x');
  host.classList.toggle('reel-bare', bare);
  host.classList.remove('settled');
  const strip = host.firstElementChild;
  const cells = strip.children;
  const prop = axis === 'x' ? 'left' : 'top';
  const step = cells[1].getBoundingClientRect()[prop] - cells[0].getBoundingClientRect()[prop];
  const size = axis === 'x' ? cells[0].offsetWidth : cells[0].offsetHeight;
  const view = axis === 'x' ? host.clientWidth : host.clientHeight;
  const exact = view / 2 - (winIndex * step + size / 2);
  const jitter = (Math.random() - 0.5) * size * 0.8;
  const tf = v => (axis === 'x' ? `translate3d(${v}px,0,0)` : `translate3d(0,${v}px,0)`);

  strip.style.transform = tf(0);
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      strip.style.transition = `transform ${duration}ms cubic-bezier(.08,.62,.1,1)`;
      strip.style.transform = tf(exact + jitter);
      let last = -1, running = true;
      const loop = () => {
        if (!running) return;
        const m = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
        const off = axis === 'x' ? m.m41 : m.m42;
        const idx = Math.floor((view / 2 - off) / step);
        if (idx !== last) {
          if (last !== -1 && sound) sfx.tick();
          // Magnify whatever is passing the marker (and slightly its neighbours).
          if (cells[last]) cells[last].classList.remove('near');
          if (cells[idx]) cells[idx].classList.add('near');
          last = idx;
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      setTimeout(() => {
        running = false;
        strip.querySelectorAll('.near').forEach(c => c.classList.remove('near'));
        strip.style.transition = 'transform 350ms ease-out';
        strip.style.transform = tf(exact);
        setTimeout(() => { cells[winIndex].classList.add('reel-won'); host.classList.add('settled'); resolve(); }, 360);
      }, duration + 30);
    }));
  });
}

/** Reel durations for the three speeds the reference sites offer. */
export const SPEEDS = { normal: 5200, fast: 2600, turbo: 1200 };
export const speedSeg = cur => `<div class="seg speed-seg" role="group" aria-label="Animation speed">${Object.keys(SPEEDS).map(s => `<button data-speed="${s}" class="${s === cur ? 'active' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>`;

/** Bet amount input with ½ / 2× / Max buttons. Call wireAmount after rendering. */
export const amountField = (id, value = 1, label = 'Bet amount') =>
  `<div class="field"><label for="${id}">${label}</label><div class="amount"><span class="amount-coin">${coin()}</span><input id="${id}" type="number" min="0.1" step="0.1" value="${value}"><button type="button" data-amt="half">½</button><button type="button" data-amt="double">2×</button><button type="button" data-amt="max">Max</button></div></div>`;
export function wireAmount(root, input, getBalance, onChange) {
  input.closest('.amount').querySelectorAll('[data-amt]').forEach(b => b.onclick = () => {
    if (input.disabled) return;
    const v = +input.value || 0;
    const r2 = n => Math.round(n * 100) / 100;
    input.value = b.dataset.amt === 'half' ? r2(Math.max(0.1, v / 2)) : b.dataset.amt === 'double' ? r2(v * 2) : Math.floor(getBalance() * 100) / 100;
    onChange?.();
  });
  input.addEventListener('input', () => onChange?.());
}

/** Simple modal. Returns { el, close }. */
export function modal(html, { onClose, wide = false } = {}) {
  const wrap = h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><button class="modal-x" aria-label="Close">×</button>${html}</div></div>`);
  const close = () => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').onclick = close;
  document.addEventListener('keydown', esc);
  document.body.append(wrap);
  return { el: wrap.querySelector('.modal'), close };
}

export function confetti(color = '#c6ff3d') {
  const layer = h('<div class="confetti"></div>');
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('i');
    p.style.cssText = `left:${Math.random() * 100}%;background:${i % 3 ? color : '#ffc53d'};animation-delay:${Math.random() * 0.3}s;animation-duration:${1.4 + Math.random()}s;transform:rotate(${Math.random() * 360}deg)`;
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 2800);
}
