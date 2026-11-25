// Shared UI helpers: formatting, item art, toasts and the spinning reel.
import { RARITY, itemName, caseRisk, RISK_LABEL } from './data.js';
import { state } from './state.js';
import { sfx } from './sfx.js';
import { itemArtSvg, NO_PICTURE } from './art.js';

// DOM helpers. They return `any` on purpose: the views poke at many element kinds (inputs, buttons, svg) and the
// ids are validated by the browser tests, not by the type system.
export const $ = (sel: string, root: ParentNode = document): any => root.querySelector(sel);
export const $$ = (sel: string, root: ParentNode = document): any[] => [...root.querySelectorAll(sel)];
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const sleep = (ms: number): Promise<void> => new Promise<void>(r => setTimeout(r, ms));
export const h = (html: string): any => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export const coin = (cls = '') => `<svg class="coin ${cls}" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#ffc53d"/><circle cx="10" cy="10" r="6.2" fill="none" stroke="#b07a00" stroke-width="1.6"/><path d="M10.8 5.5 7.5 10.6h2.6l-.9 3.9 3.3-5.1H9.9z" fill="#7a5200"/></svg>`;
export const money = (n, cls = '') => `<span class="money ${cls}">${coin()}${fmt(n)}</span>`;

/** The item's picture (see art.ts). `eager` for pictures inside a moving reel. */
export const itemArt = (item, eager = false) => itemArtSvg(item, eager);

/**
 * Fetch the pictures of these items now, so a reel that is about to spin shows them from its first frame. Resolves when every one has loaded or failed, or after
 * `timeoutMs` (a slow connection never holds a spin for long). Pictures already in the browser's cache resolve at once.
 */
export function preloadImages(items: { img?: string }[], timeoutMs = 2500): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve();
  const urls = [...new Set(items.map(i => i.img).filter((u): u is string => !!u))];
  if (!urls.length) return Promise.resolve();
  return new Promise<void>(resolve => {
    let left = urls.length;
    const timer = setTimeout(resolve, timeoutMs);
    const one = (): void => { if (--left <= 0) { clearTimeout(timer); resolve(); } };
    for (const u of urls) { const im = new Image(); im.onload = one; im.onerror = one; im.decoding = 'async'; im.referrerPolicy = 'no-referrer'; im.src = u; }
  });
}

export function itemCard(item, { compact = false, extra = '', cls = '', eager = false } = {}) {
  const r = RARITY[item.rarity];
  return `<div class="item ${compact ? 'item-compact' : ''} ${cls}" style="--rc:${r.color}" title="${esc(itemName(item))}">
    <div class="item-glow"></div>
    ${item.wear ? `<span class="wear">${item.wear}</span>` : ''}
    ${itemArt(item, eager)}
    <div class="item-meta"><div class="item-weapon">${item.st ? '<b class="st">ST</b> ' : ''}${item.souv ? '<b class="st">SV</b> ' : ''}${esc(item.weapon)}</div><div class="item-skin">${esc(item.skin)}</div></div>
    <div class="item-value">${money(item.value)}</div>${extra}
  </div>`;
}

/** The picture of a case (assets/cases/<id>.webp, set in src/data.ts). */
export function caseArt(c, size = '') {
  return `<img class="case-art case-img ${size}" src="${c.img || NO_PICTURE}" alt="" loading="lazy" decoding="async" draggable="false" data-fallback="grey">`;
}

const AV_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'];
export function avatar(name, size = 28) {
  let hsh = 0; for (const ch of name) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  const col = name === state.name ? '#c6ff3d' : AV_COLORS[Math.abs(hsh) % AV_COLORS.length];
  // The signed-in player's own picture (from Steam or Google) replaces the initial. Only https image URLs are used.
  const pic = name === state.name && typeof state.avatar === 'string' && /^https:\/\//.test(state.avatar) ? state.avatar : '';
  if (pic) return `<span class="avatar has-img" style="--av:${col};width:${size}px;height:${size}px;font-size:${size * 0.42}px">${esc(name[0].toUpperCase())}<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer" loading="lazy" data-fallback="remove"></span>`;
  return `<span class="avatar" style="--av:${col};width:${size}px;height:${size}px;font-size:${size * 0.42}px">${esc(name[0].toUpperCase())}</span>`;
}

/**
 * Short message. Settings > Notifications off hides the plain ones; errors and anything passed `force` (limits, sign-in, responsible-play
 * messages) always show. The container is a polite live region, so screen readers announce them.
 */
export function toast(msg, kind = 'info', force = false) {
  if (!state.ui.notify && kind !== 'error' && !force) return;
  const el = h(`<div class="toast toast-${kind}">${msg}</div>`);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

/** A card for signed-out visitors on pages that are about the player's own data. The buttons open the login popup (handled in auth.ts). */
export const guestCard = (title: string, text: string): string =>
  `<section class="panel guest-card"><div><b>${esc(title)}</b><span class="muted">${esc(text)}</span></div><div class="row"><button type="button" class="btn btn-primary" data-auth-open="register">Create free account</button><button type="button" class="btn btn-ghost" data-auth-open="login">Log in</button></div></section>`;

/** A toast that Settings > Notifications can never hide. */
export const toastKeep = (msg: string, kind = 'info'): void => toast(msg, kind, true);

/** On a phone the arena or the reels sit below the controls the player just pressed, so a battle or an opening would start out of sight:
 *  bring them into view (smoothly, unless the player asked for less motion). Does nothing on wide screens or when the top is already visible. */
export function bringIntoView(node: Element | null | undefined): void {
  try {
    if (!node || !globalThis.matchMedia?.('(max-width: 900px)').matches) return;
    const top = node.getBoundingClientRect().top;
    if (top >= 70 && top <= globalThis.innerHeight * 0.5) return;
    const calm = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // scroll the page itself (not scrollIntoView, which would also slide a sideways-scrolling board that holds the node); 78 px leaves room for the top bar
    globalThis.scrollTo({ top: Math.max(0, globalThis.scrollY + top - 78), behavior: calm ? 'auto' : 'smooth' });
  } catch { /* scrolling is a nicety: never let it break a game */ }
}

export const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
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
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c.6-1.6 1.7-2.3 2.5-2.3s1.9.7 2.5 2.3M14 10h4M14 13h3"/>',
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
export const bareCell = it => `<div class="reel-cell bare" style="--rc:${RARITY[it.rarity].color}"><div class="bare-glow"></div>${itemArt(it, true)}<div class="bare-meta"><b>${esc(it.skin)}</b>${money(it.value)}</div></div>`;

/**
 * How far along its way the strip is after a fraction t of the spin time (0 to 1). The speed starts from rest, picks up in the first few percent, then falls
 * away smoothly (speed ~ (1 - t)^1.5), so the reel races through the case, slows to a crawl over the last tiles and stops with no speed left: no snap, no bounce.
 */
const CURVE_STEPS = 600;
const REEL_CURVE: number[] = (() => {
  const out: number[] = []; let sum = 0;
  for (let i = 0; i <= CURVE_STEPS; i++) { const t = i / CURVE_STEPS, r = Math.min(1, t / 0.05); sum += r * r * (3 - 2 * r) * Math.pow(1 - t, 1.5); out.push(sum); }
  return out.map(v => v / sum);
})();
export const reelProgress = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const f = t * CURVE_STEPS, i = Math.floor(f);
  return (REEL_CURVE[i] as number) + ((REEL_CURVE[i + 1] as number) - (REEL_CURVE[i] as number)) * (f - i);
};

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

  host.innerHTML = `<div class="reel-strip">${list.map(it => (bare ? bareCell(it) : `<div class="reel-cell">${itemCard(it, { compact: true, eager: true })}</div>`)).join('')}</div><div class="reel-marker"></div>`;
  host.classList.add('reel', axis === 'y' ? 'reel-y' : 'reel-x');
  host.classList.toggle('reel-bare', bare);
  host.classList.remove('settled');
  const strip = host.firstElementChild;
  const cells = strip.children;
  const prop = axis === 'x' ? 'left' : 'top';
  const step = cells[1].getBoundingClientRect()[prop] - cells[0].getBoundingClientRect()[prop];
  const size = axis === 'x' ? cells[0].offsetWidth : cells[0].offsetHeight;
  const view = axis === 'x' ? host.clientWidth : host.clientHeight;
  // Where the strip comes to rest: the winning tile under the marker, a little off-centre like a real reel (never near a tile edge, so the result is unmistakable).
  const target = view / 2 - (winIndex * step + size / 2) + (Math.random() - 0.5) * size * 0.56;
  const tf = (v: number): string => (axis === 'x' ? `translate3d(${v}px,0,0)` : `translate3d(0,${v}px,0)`);
  const dpr = globalThis.devicePixelRatio || 1, snap = (v: number): number => Math.round(v * dpr) / dpr;     // whole device pixels: art stays sharp while it moves

  strip.style.transition = 'none';
  strip.style.transform = tf(0);
  host.classList.add('spinning');
  return new Promise<void>(resolve => {
    let t0 = -1, last = -1, done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      strip.style.transform = tf(snap(target));
      host.classList.remove('spinning');
      setTimeout(() => { cells[winIndex].classList.add('reel-won'); host.classList.add('settled'); resolve(); }, 140);     // a short breath before the winner lights up
    };
    const frame = (now: number): void => {
      if (done) return;
      if (t0 < 0) t0 = now;
      const t = Math.min(1, (now - t0) / duration), off = target * reelProgress(t);
      strip.style.transform = tf(snap(off));
      if (sound && step > 0) {
        const idx = Math.floor((view / 2 - off) / step);
        if (idx !== last) { if (last !== -1) sfx.tick(); last = idx; }
      }
      if (t < 1) requestAnimationFrame(frame); else finish();
    };
    requestAnimationFrame(frame);
    setTimeout(finish, duration + 500);                    // a tab in the background pauses animation frames: still end on time
  });
}

/** Reel durations for the three speeds the reference sites offer. */
export const SPEEDS = { normal: 5200, fast: 2600, turbo: 1200 };
/** How long a case battle rests on what everyone pulled before the next case starts, in ms. It used to be 400 (150 on Turbo), too short to read the item names and values. */
export const ROUND_PAUSE = { normal: 2600, fast: 1800, turbo: 800 };
export const roundPauseMs = (): number => ROUND_PAUSE[state.speed] ?? ROUND_PAUSE.normal;       // not shortened by reduced motion: it is reading time
/** Case opening: the normal length, or the fast open (the lightning button) which is between the old Fast and Turbo. People who ask their system for less motion always get the quickest. */
export const OPEN_MS = { normal: 5200, fast: 1800, reduced: 1200 } as const;
export const openMs = (): number => ((() => { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })() ? OPEN_MS.reduced : state.ui.fastOpen ? OPEN_MS.fast : OPEN_MS.normal);
/** Reel length in ms: the player's chosen speed, or the fastest one when their system asks for reduced motion. */
export const reelMs = (): number => ((() => { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })() ? SPEEDS.turbo : (SPEEDS[state.speed] || SPEEDS.normal));
export const speedSeg = cur => `<div class="seg speed-seg" role="group" aria-label="Animation speed">${Object.keys(SPEEDS).map(s => `<button data-speed="${s}" class="${s === cur ? 'active' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>`;

/** A case's risk label: Low, Medium or High, with the exact chance in the tooltip and for screen readers. */
export function riskBadge(c): string {
  const r = caseRisk(c), pct = `${(r.back * 100).toFixed(1)}%`;
  return `<span class="risk-badge risk-${r.level}" title="${pct} chance to pull an item worth at least the price"><i aria-hidden="true"></i>${RISK_LABEL[r.level]}<span class="sr-only">: ${pct} chance to pull an item worth at least the price</span></span>`;
}

/** Bet amount input with ½ / 2× / Max buttons. Call wireAmount after rendering. */
export const amountField = (id, value = 1, label = 'Bet amount') =>
  `<div class="field"><label for="${id}">${label}</label><div class="amount"><span class="amount-coin">${coin()}</span><input id="${id}" type="number" min="0.1" step="0.1" value="${value}"><button type="button" data-amt="half">½</button><button type="button" data-amt="double">2×</button><button type="button" data-amt="max">Max</button></div></div>`;
export function wireAmount(root: ParentNode, input: any, getBalance: () => number, onChange?: () => void) {
  input.closest('.amount').querySelectorAll('[data-amt]').forEach(b => b.onclick = () => {
    if (input.disabled) return;
    const v = +input.value || 0;
    const r2 = n => Math.round(n * 100) / 100;
    input.value = b.dataset.amt === 'half' ? r2(Math.max(0.1, v / 2)) : b.dataset.amt === 'double' ? r2(v * 2) : Math.floor(getBalance() * 100) / 100;
    onChange?.();
  });
  input.addEventListener('input', () => onChange?.());
}

/** Dialogs on screen, topmost last. Only the topmost traps Tab. */
const dialogs: HTMLElement[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let dialogSeq = 0;

/**
 * Accessible modal. Returns { el, close }.
 * Focus moves into the dialog and comes back to the opener on close; Tab stays inside; the page behind is made inert.
 * `label` names the dialog for screen readers (otherwise its first heading is used). `locked` removes Escape and backdrop closing.
 */
export function modal(html: string, { onClose, wide = false, locked = false, label = '', backdropClose = true }: { onClose?: () => void; wide?: boolean; locked?: boolean; label?: string; backdropClose?: boolean } = {}): { el: any; close: () => void } {
  const opener = document.activeElement as HTMLElement | null;
  const wrap = h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" tabindex="-1"${label ? ` aria-label="${esc(label)}"` : ''}><button class="modal-x" aria-label="Close">×</button>${html}</div></div>`);
  const box = wrap.querySelector('.modal') as HTMLElement;
  if (!label) { const hd = box.querySelector('h1, h2, h3'); if (hd) { hd.id = hd.id || `dlg${++dialogSeq}`; box.setAttribute('aria-labelledby', hd.id); } }
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    wrap.classList.add('out'); setTimeout(() => wrap.remove(), 200);
    document.removeEventListener('keydown', onKey);
    const i = dialogs.indexOf(wrap); if (i >= 0) dialogs.splice(i, 1);
    if (!dialogs.length) document.querySelector('.app')?.removeAttribute('inert');
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (dialogs[dialogs.length - 1] !== wrap) return;
    if (e.key === 'Escape' && !locked) { close(); return; }
    if (e.key !== 'Tab') return;
    const items = ([...box.querySelectorAll(FOCUSABLE)] as HTMLElement[]).filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { e.preventDefault(); box.focus(); return; }
    const first = items[0] as HTMLElement, last = items[items.length - 1] as HTMLElement, at = document.activeElement;
    if (e.shiftKey && (at === first || at === box || !box.contains(at))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || !box.contains(at))) { e.preventDefault(); first.focus(); }
  };
  wrap.addEventListener('click', e => { if (e.target === wrap && !locked && backdropClose) close(); });
  wrap.querySelector('.modal-x').onclick = close;
  if (locked) wrap.classList.add('locked');
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  dialogs.push(wrap);
  document.querySelector('.app')?.setAttribute('inert', '');
  const firstField = box.querySelector('input:not([type="hidden"]), select, textarea') as HTMLElement | null;
  (firstField ?? box).focus({ preventScroll: true });
  return { el: box, close };
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
