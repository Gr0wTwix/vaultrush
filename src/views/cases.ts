import { CASES, CASE, ITEM, RARITY, entryForTicket, ticketOf } from '../data.js';
import { state, save, debit, credit, addItems, removeItems, round2, debitError } from '../state.js';
import { bet, annotate } from '../fair.js';
import { pushDrop, pushBet } from '../feed.js';
import { $, $$, esc, fmt, money, caseArt, itemCard, spinReel, toast, confetti, icon, SPEEDS, reelMs, speedSeg } from '../ui.js';
import { sfx } from '../sfx.js';
import { eyeBtn } from '../preview.js';

const PRICE_BANDS = [['all', 'All prices', 0, Infinity], ['low', 'Under 5', 0, 5], ['mid', '5 – 50', 5, 50], ['high', '50+', 50, Infinity]] as [string, string, number, number][];

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
  let count = 1, busy = false, alive = true;

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
          ${speedSeg(state.speed)}
        </div>
      </div>
    </section>
    <section class="reels" id="reels"></section>
    <section class="result" id="result" hidden></section>
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

  $('#fav', el).onclick = () => { toggleFav(c.id); $('#fav', el).classList.toggle('on', state.favs.includes(c.id)); };
  $$('#count button', el).forEach(b => b.onclick = () => {
    if (busy) return;
    count = +b.dataset.n;
    $$('#count button', el).forEach(x => x.classList.toggle('active', x === b));
    $('#result', el).hidden = true;
    drawIdle();
  });
  $$('.speed-seg button', el).forEach(b => b.onclick = () => { state.speed = b.dataset.speed; save(); $$('.speed-seg button', el).forEach(x => x.classList.toggle('active', x === b)); });

  // 1–2 cases spin horizontally; 3+ spin as vertical columns side by side (like the reference sites).
  const spinAll = winners => {
    const axis = winners.length > 2 ? 'y' : 'x';
    reels.innerHTML = winners.map(() => '<div class="reel-host"></div>').join('');
    const dur = reelMs();
    return Promise.all([...reels.children].map((host, i) => spinReel(host, c.entries, winners[i], { axis, duration: dur + i * 90, sound: i === 0, ...(axis === 'y' ? { total: 40, winIndex: 34 } : {}) })));
  };

  const setBusy = v => { busy = v; openBtn.disabled = v; $('#demoBtn', el).disabled = v; };

  $('#demoBtn', el).onclick = async () => {
    if (busy) return;
    setBusy(true); $('#result', el).hidden = true;
    const winners = Array.from({ length: count }, () => entryForTicket(c, ticketOf(Math.random())).item);
    await spinAll(winners);
    if (alive) { toast('Demo spin: no coins used, nothing won'); setBusy(false); }
  };

  openBtn.onclick = async () => {
    if (busy) return;
    const cost = round2(c.price * count);
    if (!debit(cost)) return toast(debitError(cost), 'error');
    setBusy(true); sfx.click(); $('#result', el).hidden = true;
    // One nonce per case opened (consecutive nonces, like the reference sites).
    const rolls = [];
    for (let i = 0; i < count; i++) {
      const { floats, entry } = await bet('cases', 1, { case: c.id });
      const ticket = ticketOf(floats[0]);
      const item = entryForTicket(c, ticket).item;
      annotate(entry, `${c.name}: ticket #${ticket} → ${item.weapon} | ${item.skin}`, `${ticket}:${item.id}`);
      rolls.push({ ticket, item });
    }
    const winners = rolls.map(r => r.item);
    // Items are granted right away, so leaving mid-spin never loses them.
    const added = addItems(winners);
    const total = round2(winners.reduce((s, w) => s + w.value, 0));
    pushBet({ user: state.name, game: 'Cases', amount: cost, multi: round2(total / cost), payout: total, mine: true });
    await spinAll(winners);
    winners.forEach(w => pushDrop({ user: state.name, item: w, source: c.name }));
    if (!alive) return;
    setBusy(false);

    const best = winners.reduce((a, b) => (b.value > a.value ? b : a));
    if (['legendary', 'mythic'].includes(best.rarity)) { sfx.big(); confetti(RARITY[best.rarity].color); }
    else if (total >= cost) sfx.win(); else sfx.lose();

    const res = $('#result', el);
    res.hidden = false;
    const draw = () => {
      const still = added.filter(a => state.inv.some(i => i.uid === a.uid));
      res.innerHTML = `
        <div class="result-head"><div><h2>You unboxed ${money(total)}</h2><span class="muted">Cost ${money(cost)} · ${total >= cost ? '<span class="pos">profit</span>' : '<span class="neg">loss</span>'} ${money(round2(total - cost))}</span></div>
          <div class="row">${still.length ? `<button class="btn btn-ghost" id="sellAll">Sell all for ${money(round2(still.reduce((s, a) => s + ITEM[a.id].value, 0)))}</button>` : ''}<button class="btn btn-primary" id="again">Open again</button></div></div>
        <div class="contents">${added.map((a, i) => {
          const kept = still.includes(a);
          return itemCard(ITEM[a.id], { cls: kept ? '' : 'sold', extra: `<div class="chance">#${rolls[i].ticket}</div>${kept ? `<button class="btn btn-sm sell" data-uid="${a.uid}">Sell</button>` : '<div class="muted small">Sold</div>'}` });
        }).join('')}</div>`;
      $$('.sell', res).forEach(b => b.onclick = () => { const a = added.find(x => x.uid === b.dataset.uid); removeItems([a.uid]); credit(ITEM[a.id].value); sfx.click(); draw(); });
      const sa = $('#sellAll', res);
      if (sa) sa.onclick = () => { removeItems(still.map(a => a.uid)); credit(round2(still.reduce((s, a) => s + ITEM[a.id].value, 0))); sfx.win(); draw(); };
      $('#again', res).onclick = () => openBtn.click();
    };
    draw();
    res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  return () => { alive = false; };
}
