import { ITEM } from '../data.js';
import { state, credit, removeItems, round2, resetAccount, START_BALANCE, isAuthed } from '../state.js';
import { serverWallet, sellItems } from '../wallet.js';
import { $, $$, fmt, money, itemCard, icon, toast, guestCard } from '../ui.js';
import { sfx } from '../sfx.js';

export function render(el) {
  const draw = () => {
    if (!isAuthed()) {
      el.innerHTML = `<div class="page-head"><h1>${icon('bag')} Inventory</h1></div>${guestCard('Your items live in your account', 'Open cases, win items and sell them for coins. Create a free account to start playing.')}`;
      return;
    }
    const total = round2(state.inv.reduce((s, e) => s + ITEM[e.id].value, 0));
    const s = state.stats;
    el.innerHTML = `
      <div class="page-head"><h1>${icon('bag')} Inventory</h1></div>
      <div class="stat-row">
        <div class="stat"><span class="muted small">Balance</span>${money(state.balance)}</div>
        <div class="stat"><span class="muted small">Inventory value</span>${money(total)}</div>
        <div class="stat"><span class="muted small">Wagered</span>${money(s.wagered)}</div>
        <div class="stat"><span class="muted small">Bets</span><b>${s.bets}</b></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>${state.inv.length} items</h2><div class="row">${state.inv.length ? `<button class="btn btn-primary" id="sellAll" data-needs-auth="inventory">Sell all for ${money(total)}</button>` : ''}</div></div>
        <div class="contents">${state.inv.map(e => itemCard(ITEM[e.id], { extra: `<button class="btn btn-sm sell" data-needs-auth="inventory" data-u="${e.uid}">Sell</button>` })).join('') || '<div class="muted">Nothing here yet. <a href="#/cases">Open a case</a>.</div>'}</div>
      </div>
      ${serverWallet() ? '' : `<div class="panel danger-zone"><div><b>Reset demo account</b><div class="muted small">Sets your balance back to ${fmt(START_BALANCE)} and clears your inventory.</div></div><button class="btn btn-ghost" id="reset">Reset</button></div>`}`;
    $$('.sell', el).forEach(b => b.onclick = async () => {
      const e = state.inv.find(x => x.uid === b.dataset.u); if (!e) return;
      if (serverWallet()) { try { await sellItems([e.uid]); } catch (er) { return toast(er instanceof Error ? er.message : 'Could not sell', 'error'); } }
      else { removeItems([e.uid]); credit(ITEM[e.id].value); }
      sfx.click(); draw();
    });
    const sa = $('#sellAll', el);
    if (sa) sa.onclick = async () => {
      const t = total;
      if (serverWallet()) { try { await sellItems(null); } catch (er) { return toast(er instanceof Error ? er.message : 'Could not sell', 'error'); } }
      else { removeItems(state.inv.map(e => e.uid)); credit(t); }
      sfx.win(); toast(`Sold everything for ${fmt(t)}`, 'win'); draw();
    };
    const rs = $('#reset', el);
    if (rs) rs.onclick = () => { if (confirm('Reset your demo balance and inventory?')) { resetAccount(); draw(); } };
  };
  draw();
}
