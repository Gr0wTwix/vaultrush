import { CASES, CASE, ITEM, RARITY, entryForTicket, ticketOf, isHugeDrop } from '../data.js';
import { state, save, debit, addItems, round2, debitError } from '../state.js';
import { bet, annotate } from '../fair.js';
import { pushDrop, pushBet } from '../feed.js';
import { $, $$, esc, fmt, money, caseArt, itemCard, spinReel, toast, confetti, icon, openMs, preloadImages } from '../ui.js';
import { sfx } from '../sfx.js';
import { eyeBtn } from '../preview.js';
import { serverWallet, openCases, releaseItems } from '../wallet.js';

const PRICE_BANDS = [['all', 'All prices', 0, Infinity], ['low', 'Under 5', 0, 5], ['mid', '5 – 50', 5, 50], ['high', '50 – 250', 50, 250], ['vip', '250+', 250, Infinity]] as [string, string, number, number][];

export function renderList(el) {
  let sort = 'price-asc', band = 'all', tag = 'all', q = '';
  el.innerHTML = `
    <div class="page-head"><h1>${icon('cases')} Cases</h1><p class="muted">Every case lists each item's drop chance and ticket range. Prices are set for a 90% average return.</p></div>
    <div class="toolbar">
      <input id="q" class="search" placeholder="Search cases…" autocomplete="off">
      <select id="band">${PRICE_BANDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <div class="tabs" id="tag"><button class="tab active" data-t="all">All</button><button class="tab" data-t="official">Official</button><button class="tab" data-t="odds">50% / 10%</button><button class="tab" data-t="fav">${icon('star')} Favourites</button></div>
      <div class="tabs" id="sort"><button class="tab active" data-s="price-asc">Cheapest</button><button class="tab" data-s="price-desc">Priciest</button></div>
    </div>
    <section class="case-grid big" id="grid"></section>`;

  const draw = () => {
    const [, , lo, hi] = PRICE_BANDS.find(b => b[0] === band) as [string, string, number, number];
    const list = CASES
      .filter(c => c.price >= lo && c.price < hi)
      .filter(c => tag === 'all' || (tag === 'fav' ? state.favs.includes(c.id) : tag === 'odds' ? c.tag !== 'official' : c.tag === tag))
      .filter(c => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => (sort === 'price-asc' ? a.price - b.price : b.price - a.price));
    $('#grid', el).innerHTML = list.map(c => `<a class="case-card" href="#/case/${c.id}" data-case="${c.id}" style="--hue:${c.hue}">
      ${eyeBtn(c.id)}<button class="fav ${state.favs.includes(c.id) ? 'on' : ''}" data-fav="${c.id}" aria-label="Favourite">${icon('star')}</button>
      ${c.tag !== 'official' ? `<span class="case-tag">${esc(c.tag)}</span>` : ''}
      ${caseArt(c)}<b>${esc(c.name)}</b><span class="muted small">Top drop ${money(c.entries[0].item.value)}</span>${money(c.price, 'price')}</a>`).join('')
      || '<div class="muted">No cases match. <a href="#/cases" id="clr">Clear filters</a></div>';
    $$('[data-fav]', el).forEach(b => b.onclick = e => { e.preventDefault(); toggleFav(b.dataset.fav); draw(); });
  };
  $('#q', el).oninput = e => { q = e.target.value.trim().toLowerCase(); draw(); };
  $('#band', el).onchange = e => { band = e.target.value; draw(); };
  $$('#tag .tab', el).forEach(t => t.onclick = () => { $$('#tag .tab', el).forEach(x => x.classList.toggle('active', x === t)); tag = t.dataset.t; draw(); });
  $$('#sort .tab', el).forEach(t => t.onclick = () => { $$('#sort .tab', el).forEach(x => x.classList.toggle('active', x === t)); sort = t.dataset.s; draw(); });
  draw();
}

function toggleFav(id) {
  state.favs = state.favs.includes(id) ? state.favs.filter(f => f !== id) : [...state.favs, id];
  save();
}

export function renderCase(el, id) {
  const c = CASE[id];
  if (!c || c.reward) { el.innerHTML = `<div class="panel empty"><h2>Case not found</h2><a class="btn btn-primary" href="#/cases">All cases</a></div>`; return; }
  let count = 1, busy = false, alive = true, held: string[] = [];       // items the server has given but whose reels are still turning

  el.innerHTML = `
    <a class="back" href="#/cases">← All cases</a>
    <section class="case-hero" style="--hue:${c.hue}">
      <div class="case-hero-art">${caseArt(c, 'xl')}</div>
      <div class="case-hero-info">
        <div class="row"><h1>${esc(c.name)}</h1><button class="fav big ${state.favs.includes(c.id) ? 'on' : ''}" id="fav" aria-label="Favourite">${icon('star')}</button></div>
        <div class="muted">${c.entries.length} items · top drop ${money(c.entries[0].item.value)}</div>
        <div class="open-controls">
          <div class="seg" id="count">${[1, 2, 3, 4, 6].map(n => `<button class="${n === 1 ? 'active' : ''}" data-n="${n}">${n}</button>`).join('')}</div>
          <button class="btn btn-primary btn-lg" id="openBtn" data-needs-auth="bet"></button>
          <button class="btn btn-ghost" id="demoBtn">Demo spin</button>
          <button class="btn btn-ghost fast-toggle ${state.ui.fastOpen ? 'on' : ''}" id="fastBtn" type="button" aria-pressed="${state.ui.fastOpen}" aria-label="Fast open" title="Fast open: a quicker spin (also for demo spins)">${icon('bolt')}</button>
        </div>
      </div>
    </section>
    <section class="reels" id="reels"></section>
    <div class="panel"><div class="panel-head"><h2>Case contents</h2><span class="muted small">Each roll picks a ticket from 0 to 99,999</span></div>
      <div class="contents">${c.entries.map(e => itemCard(e.item, { extra: `<div class="chance">${(e.chance * 100).toFixed(e.chance < 0.01 ? 3 : 2)}%</div><div class="tickets">#${fmt(e.from).replace('.00', '')} – #${fmt(e.to).replace('.00', '')}</div>` })).join('')}</div>
    </div>`;

  const reels = $('#reels', el);
  const openBtn = $('#openBtn', el);
  const drawIdle = () => {
    openBtn.innerHTML = `Open ${count > 1 ? `${count}× ` : ''}for ${money(round2(c.price * count))}`;
    reels.className = `reels n${count}`;
    reels.innerHTML = Array.from({ length: count }, () => `<div class="reel-host reel ${count > 2 ? 'reel-y' : 'reel-x'} idle">${caseArt(c)}</div>`).join('');
  };
  drawIdle();
  void preloadImages(c.entries.map(e => e.item));                       // the pictures are in the browser before the first spin

  $('#fav', el).onclick = () => { toggleFav(c.id); $('#fav', el).classList.toggle('on', state.favs.includes(c.id)); };
  $$('#count button', el).forEach(b => b.onclick = () => {
    if (busy) return;
    count = +b.dataset.n;
    $$('#count button', el).forEach(x => x.classList.toggle('active', x === b));
    drawIdle();
  });

  // 1–2 cases spin horizontally; 3+ spin as vertical columns side by side (like the reference sites).
  const spinAll = winners => {
    const axis = winners.length > 2 ? 'y' : 'x';
    const dur = openMs();
    return preloadImages(c.entries.map(e => e.item)).then(() => {
      reels.innerHTML = winners.map(() => '<div class="reel-host"></div>').join('');
      return Promise.all([...reels.children].map((host, i) => spinReel(host, c.entries, winners[i], { axis, duration: dur + i * 90, sound: i === 0, ...(axis === 'y' ? { total: 40, winIndex: 34 } : {}) })));
    });
  };

  $('#fastBtn', el).onclick = () => {
    state.ui.fastOpen = !state.ui.fastOpen; save();
    const f = $('#fastBtn', el); f.classList.toggle('on', state.ui.fastOpen); f.setAttribute('aria-pressed', String(state.ui.fastOpen));
    sfx.click();
  };
  const setBusy = v => { busy = v; openBtn.disabled = v; $('#demoBtn', el).disabled = v; };

  $('#demoBtn', el).onclick = async () => {
    if (busy) return;
    setBusy(true);
    const winners = Array.from({ length: count }, () => entryForTicket(c, ticketOf(Math.random())).item);
    await spinAll(winners);
    if (alive) { toast('Demo spin: no coins used, nothing won'); setBusy(false); }
  };

  openBtn.onclick = async () => {
    if (busy) return;
    const cost = round2(c.price * count);
    if (!debit(cost)) return toast(debitError(cost), 'error');
    setBusy(true); sfx.click();
    let rolls = [], added = [];
    if (serverWallet()) {
      // The database takes the price, draws the tickets from your secret seed and puts the items in your inventory before it answers.
      try {
        const r = await openCases(c.id, count);
        rolls = r.opened.map(o => ({ ticket: o.ticket, item: ITEM[o.item] }));
        added = r.opened.map(o => ({ uid: o.uid, id: o.item, at: Date.now() }));
        held = added.map(a => a.uid);
      } catch (e) { setBusy(false); return toast(e instanceof Error ? e.message : 'Could not open the case', 'error'); }
    } else {
      // One nonce per case opened (consecutive nonces, like the reference sites).
      for (let i = 0; i < count; i++) {
        const { floats, entry } = await bet('cases', 1, { case: c.id });
        const ticket = ticketOf(floats[0]);
        const item = entryForTicket(c, ticket).item;
        annotate(entry, `${c.name}: ticket #${ticket} → ${item.weapon} | ${item.skin}`, `${ticket}:${item.id}`);
        rolls.push({ ticket, item });
      }
      // Items are granted right away, so leaving mid-spin never loses them.
      added = addItems(rolls.map(r => r.item));
    }
    const winners = rolls.map(r => r.item);
    const total = round2(winners.reduce((s, w) => s + w.value, 0));
    pushBet({ user: state.name, game: 'Cases', amount: cost, multi: round2(total / cost), payout: total, mine: true });
    await spinAll(winners);
    releaseItems(held); held = [];                                      // the reels have stopped: now the top bar counts them
    winners.forEach(w => pushDrop({ user: state.name, item: w, source: c.name }));
    if (!alive) return;
    setBusy(false);

    const best = winners.reduce((a, b) => (b.value > a.value ? b : a));
    if (isHugeDrop(best.rarity) || best.value >= cost * 5) { sfx.big(); confetti(RARITY[best.rarity].color); }
    else if (total >= cost) sfx.win(); else sfx.lose();
  };

  return () => { alive = false; releaseItems(held); };               // leaving mid-spin: the items are in the inventory, show them
}
