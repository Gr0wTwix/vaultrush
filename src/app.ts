// Styles are bundled by Vite (order matters: base first, then page-specific layers).
import './css/app.css';
import './css/games.css';
import './css/home.css';
import './css/account.css';
import './css/battles2.css';
import './css/compliance.css';
import { state, save, on, credit, logTx, FREE_COINS, FREE_COINS_EVERY_MS } from './state.js';
import { initFair } from './fair.js';
import { startFeed, drops } from './feed.js';
import { RARITY, CASES, REWARD_CASES } from './data.js';
import { $, $$, esc, fmt, coin, icon, avatar, toast, h, itemArt, caseArt } from './ui.js';
import { sfx } from './sfx.js';
import { openAccount, applyUi } from './account.js';
import { initRg } from './rgui.js';
import { openAuth, initAuth, isSignedIn, localSignedIn, logout } from './auth.js';
import * as legal from './views/legal.js';
import * as responsible from './views/responsible.js';
import * as rngLab from './views/rng.js';
import { initChat } from './chat.js';
import * as home from './views/home.js';
import * as cases from './views/cases.js';
import * as battles from './views/battles.js';
import * as crash from './views/crash.js';
import * as upgrade from './views/upgrade.js';
import * as mines from './views/mines.js';
import * as fair from './views/fair.js';
import * as inventory from './views/inventory.js';
import * as double from './views/double.js';
import * as plinko from './views/plinko.js';
import * as coinflip from './views/coinflip.js';
import * as rewards from './views/rewards.js';
import * as leaderboard from './views/leaderboard.js';
import * as profile from './views/profile.js';
import { settlePastRace } from './race.js';
import { level } from './state.js';

const NAV = [
  [null, 'Play'],
  ['#/', 'home', 'Home'], ['#/cases', 'cases', 'Cases'], ['#/battles', 'battles', 'Battles'], ['#/upgrade', 'upgrade', 'Upgrade'],
  [null, 'Originals'],
  ['#/crash', 'crash', 'Crash'], ['#/double', 'double', 'Double'], ['#/plinko', 'plinko', 'Plinko'],
  ['#/mines', 'mines', 'Mines'], ['#/coinflip', 'coin', 'Coinflip'],
  [null, 'Rewards'],
  ['#/rewards', 'gift', 'Rewards'], ['#/leaderboard', 'trophy', 'Race'], ['#/fair', 'fair', 'Fairness'],
];

type Route = [RegExp, (el: HTMLElement, ...args: string[]) => (() => void) | void, string];
const ROUTES: Route[] = [
  [/^#\/double$/, double.render, 'double'],
  [/^#\/plinko$/, plinko.render, 'plinko'],
  [/^#\/coinflip$/, coinflip.render, 'coin'],
  [/^#\/rewards$/, rewards.render, 'gift'],
  [/^#\/leaderboard$/, leaderboard.render, 'trophy'],
  [/^#\/profile$/, profile.render, 'profile'],
  [/^#?\/?$/, home.render, 'home'],
  [/^#\/cases$/, cases.renderList, 'cases'],
  [/^#\/case\/([\w-]+)$/, cases.renderCase, 'cases'],
  [/^#\/battles$/, battles.renderList, 'battles'],
  [/^#\/battles\/create$/, battles.renderCreate, 'battles'],
  [/^#\/battle\/([\w-]+)$/, battles.renderBattle, 'battles'],
  [/^#\/crash$/, crash.render, 'crash'],
  [/^#\/upgrade$/, upgrade.render, 'upgrade'],
  [/^#\/mines$/, mines.render, 'mines'],
  [/^#\/fair$/, fair.render, 'fair'],
  [/^#\/responsible$/, responsible.render, 'fair'],
  [/^#\/terms$/, legal.renderTerms, 'fair'],
  [/^#\/privacy$/, legal.renderPrivacy, 'fair'],
  [/^#\/rng$/, rngLab.render, 'fair'],
  [/^#\/inventory$/, inventory.render, 'inventory'],
];

function renderSidebar() {
  $('#sidebar').innerHTML = `
    <a class="logo" href="#/" aria-label="Vaultrush home"><span class="logo-mark">${icon('bolt')}</span><span class="logo-text">VAULT<b>RUSH</b></span></a>
    <div class="nav">${NAV.map(([href, ic, label]) => (href === null ? `<div class="nav-group">${ic}</div>` : `<a class="nav-link" href="${href}" data-nav="${ic}">${icon(ic)}<span>${label}</span></a>`)).join('')}</div>
    <div class="side-foot"><span class="pill-demo">PLAY MONEY</span></div>`;
}

// Avatar menu: every entry opens the Account window on the matching tab.
const ME_MENU = [
  ['account', 'Account', 'user'],
  ['options', 'Settings', 'gear'],
  ['tx', 'Transactions', 'clock'],
  ['history', 'Game History', 'list'],
];

/** Floating chat button (like the reference sites): hides or shows the chat column, with an unread badge while it is closed. */
function initChatDock() {
  const dock = h(`<button class="chat-dock" id="chatDock" aria-label="Toggle chat">${icon('chat')}<i class="chat-dock-badge" hidden></i></button>`);
  document.body.append(dock);
  const badge = dock.querySelector('.chat-dock-badge');
  const small = () => matchMedia('(max-width: 1200px)').matches;     // chat is a slide-over panel here
  const isOpen = () => (small() ? document.body.classList.contains('chat-open') : state.ui.chat);
  let unread = 0;
  const draw = () => {
    const open = isOpen();
    if (open) unread = 0;
    dock.classList.toggle('on', open);
    dock.title = open ? 'Hide chat' : 'Show chat';
    badge.hidden = !unread; badge.textContent = unread > 9 ? '9+' : String(unread);
  };
  dock.onclick = () => {
    sfx.click();
    if (small()) document.body.classList.toggle('chat-open');
    else { state.ui.chat = !state.ui.chat; save(); applyUi(); }
    draw();
  };
  on('chatmsg', user => { if (user !== state.name && !isOpen()) { unread++; draw(); } });
  new MutationObserver(draw).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', draw);
  draw();
}

function renderTopbar() {
  $('#topbar').innerHTML = `
    <a class="logo logo-mobile" href="#/">${icon('bolt')}</a>
    <div class="top-spacer"></div>
    <button class="btn btn-ghost free-btn" id="freeBtn">${icon('gift')}<span id="freeLabel">Free coins</span></button>
    <a class="balance" href="#/inventory" title="Balance and inventory">${coin()}<span id="bal">${fmt(state.balance)}</span><span class="inv-count" id="invCount">${icon('bag')}<b>${state.inv.length}</b></span></a>
    <button class="icon-btn" id="muteBtn" aria-label="Toggle sound">${icon(state.muted ? 'mute' : 'sound')}</button>
    <button class="icon-btn chat-toggle" id="chatBtn" aria-label="Toggle chat">${icon('chat')}</button>
    <div class="me-wrap">
      <button class="me" id="meBtn" aria-haspopup="menu" aria-expanded="false" title="Account">${avatar(state.name, 32)}<span class="me-lvl" id="meLvl">${level()}</span></button>
      <div class="me-menu" id="meMenu" role="menu" hidden>
        ${ME_MENU.map(([tab, label, ic, cls]) => `<button role="menuitem" data-tab="${tab}" class="${cls || ''}">${icon(ic)}<span>${label}</span></button>`).join('')}<span id="meLogout"></span>
      </div>
    </div>`;
  on('levelup', lvl => {
    $('#meLvl').textContent = lvl;
    if (!state.ui.levelPopup) return;
    sfx.big();
    toast(lvl % 10 === 0 ? `Level ${lvl}! A free level case is waiting in Rewards.` : `Level up! You're now level ${lvl}`, 'win');
  });

  const meBtn = $('#meBtn'), meMenu = $('#meMenu');
  const setMenu = open => {
    if (open) $('#meLogout').innerHTML = (isSignedIn() || localSignedIn()) ? `<button role="menuitem" data-tab="logout" class="danger">${icon('logout')}<span>Log out</span></button>` : '';
    meMenu.hidden = !open; meBtn.setAttribute('aria-expanded', String(open));
  };
  meBtn.onclick = e => { e.stopPropagation(); sfx.click(); setMenu(meMenu.hidden); };
  meMenu.onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; setMenu(false); sfx.click(); if (b.dataset.tab === 'logout') void logout(); else openAccount(b.dataset.tab); };
  document.addEventListener('click', e => { if (!meMenu.hidden && !(e.target as Element).closest('.me-wrap')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !meMenu.hidden) { setMenu(false); meBtn.focus(); } });
  $('#muteBtn').onclick = () => { state.muted = !state.muted; save(); $('#muteBtn').innerHTML = icon(state.muted ? 'mute' : 'sound'); };
  $('#chatBtn').onclick = () => document.body.classList.toggle('chat-open');
  $('#freeBtn').onclick = () => {
    const wait = state.lastClaim + FREE_COINS_EVERY_MS - Date.now();
    if (wait > 0) return toast(`Next free coins in ${Math.ceil(wait / 60000)} min`, 'error');
    state.lastClaim = Date.now();
    credit(FREE_COINS); logTx('Free coins', FREE_COINS); sfx.win();
    toast(`+${fmt(FREE_COINS)} free coins claimed`, 'win');
  };
  const tickFree = () => {
    const wait = state.lastClaim + FREE_COINS_EVERY_MS - Date.now();
    const lbl = $('#freeLabel'); if (!lbl) return;
    if (wait <= 0) { lbl.textContent = `Claim ${FREE_COINS} free`; $('#freeBtn').classList.add('ready'); }
    else { const m = Math.floor(wait / 60000), s = Math.floor((wait % 60000) / 1000); lbl.textContent = `${m}:${String(s).padStart(2, '0')}`; $('#freeBtn').classList.remove('ready'); }
  };
  tickFree(); setInterval(tickFree, 1000);

  let shown = state.balance;
  on('state', s => {
    const el = $('#bal'); if (!el) return;
    const from = shown, to = s.balance, t0 = performance.now();
    shown = to;
    el.parentElement.classList.remove('bump-up', 'bump-down'); void el.offsetWidth;
    el.parentElement.classList.add(to >= from ? 'bump-up' : 'bump-down');
    const anim = t => { const k = Math.min(1, (t - t0) / 450); el.textContent = fmt(from + (to - from) * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(anim); };
    requestAnimationFrame(anim);
    $('#invCount b').textContent = s.inv.length;
  });
}

const CASE_BY_NAME = new Map([...CASES, ...REWARD_CASES].map(c => [c.name, c]));
const REWARD_NAMES = new Set(REWARD_CASES.map(c => c.name));
/** Where clicking a drop should go: the case it came from, or the mode that produced it. */
const dropHref = src => CASE_BY_NAME.has(src) ? (REWARD_NAMES.has(src) ? '#/rewards' : `#/case/${CASE_BY_NAME.get(src).id}`) : src === 'Battle' ? '#/battles' : src === 'Upgrade' ? '#/upgrade' : '';

/** A live drop: the item up front; on hover it flips to the case it came from, and the whole chip links to that case. */
function dropChip(d) {
  const c = RARITY[d.item.rarity].color, href = dropHref(d.source), cs = CASE_BY_NAME.get(d.source);
  const tip = `${d.user} got ${d.item.weapon} | ${d.item.skin} from ${d.source}`;
  const back = cs
    ? `<span class="drop-case">${caseArt(cs)}</span><span class="drop-back-text"><small>From case</small><b>${esc(cs.name)}</b><em>Open case ›</em></span>`
    : `<span class="drop-case drop-mode">${icon(d.source === 'Upgrade' ? 'upgrade' : 'battles')}</span><span class="drop-back-text"><small>From</small><b>${esc(d.source)}</b><em>Play ›</em></span>`;
  const inner = `<span class="drop-front">${itemArt(d.item)}<span class="drop-meta"><b>${d.item.st ? '<i class="st">ST</i> ' : ''}${esc(d.item.weapon)}</b><span>${esc(d.item.skin)}</span></span></span><span class="drop-back">${back}</span>`;
  return href ? `<a class="drop" href="${href}" title="${esc(tip)}" style="--rc:${c}">${inner}</a>` : `<div class="drop" title="${esc(tip)}" style="--rc:${c}">${inner}</div>`;
}

function renderTicker() {
  const track = $('#tickerTrack');
  track.innerHTML = drops.slice(0, 12).map(dropChip).join('');
  // New drops wait while the pointer is over the strip, so the chip you're about to click doesn't slide away.
  let hovering = false; const queue = [];
  const push = d => {
    const el = h(dropChip(d)); el.classList.add('drop-in');
    track.prepend(el);
    while (track.children.length > 12) track.lastElementChild.remove();
  };
  track.addEventListener('mouseenter', () => { hovering = true; });
  track.addEventListener('mouseleave', () => { hovering = false; queue.splice(0).forEach(push); });
  on('drop', d => { if (hovering) { queue.push(d); if (queue.length > 12) queue.shift(); } else push(d); });
}

let cleanup = null;
function route() {
  const hash = location.hash || '#/';
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const view = $('#view');
  view.innerHTML = '';
  view.className = 'view';
  for (const [re, fn, nav] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
      cleanup = fn(view, ...m.slice(1)) || null;
      window.scrollTo(0, 0);
      document.body.classList.remove('chat-open');
      return;
    }
  }
  view.innerHTML = `<div class="panel empty"><h2>Page not found</h2><a class="btn btn-primary" href="#/">Go home</a></div>`;
}

async function boot() {
  await initFair();
  renderSidebar();
  renderTopbar();
  applyUi();
  initRg();
  void initAuth();
  initChatDock();
  startFeed();
  renderTicker();
  initChat($('#chat'));
  window.addEventListener('hashchange', route);
  route();
  const race = settlePastRace();
  if (race) setTimeout(() => toast(`You finished #${race.rank} in yesterday's race: +${fmt(race.prize)}`, 'win'), 800);
}

boot().catch(err => {
  console.error(err);
  document.getElementById('view').innerHTML = `<div class="panel empty"><h2>Couldn't start</h2><p>${esc(err.message)}</p><p class="muted">Open the site through <code>node server.js</code> (http://localhost:5173), not as a file.</p></div>`;
});
