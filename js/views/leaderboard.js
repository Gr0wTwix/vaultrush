import { standings, msToReset, PRIZES } from '../race.js';
import { todayKey, DAY } from '../state.js';
import { $, esc, fmt, money, icon, avatar } from '../ui.js';

const pad = n => String(n).padStart(2, '0');

export function render(el) {
  const draw = () => {
    const list = standings();
    const top3 = list.slice(0, 3), rest = list.slice(3, 10), me = list.find(p => p.me);
    const prev = standings(todayKey(Date.now() - DAY), Date.parse(`${todayKey()}T00:00:00Z`) - 1).slice(0, 3);
    el.innerHTML = `
      <div class="page-head"><h1>${icon('trophy')} Daily race</h1><p class="muted">Every coin you wager today counts. The top 10 share a ${fmt(PRIZES.reduce((a, b) => a + b, 0))} coin prize pool when the day ends (00:00 UTC). Prizes are paid the next time you visit.</p></div>
      <section class="race-head panel"><div><span class="muted small">Prize pool</span>${money(PRIZES.reduce((a, b) => a + b, 0), 'big')}</div><div class="countdown" id="cd"></div></section>
      <section class="podium">${[1, 0, 2].map(i => { const p = top3[i]; return p ? `<div class="pod pod-${i + 1} ${p.me ? 'mine' : ''}">${avatar(p.name, 46)}<b>${esc(p.name)}</b><span class="muted small">${money(p.wagered)} wagered</span><div class="pod-prize">${money(p.prize)}</div><div class="pod-rank">${i + 1}</div></div>` : ''; }).join('')}</section>
      <div class="panel"><div class="table-wrap"><table class="bets"><thead><tr><th>#</th><th>Player</th><th>Wagered</th><th>Prize</th></tr></thead><tbody>
        ${rest.map(p => `<tr class="${p.me ? 'mine' : ''}"><td>${p.rank}</td><td class="user-cell">${avatar(p.name, 22)}<span>${esc(p.name)}</span></td><td>${money(p.wagered)}</td><td>${money(p.prize)}</td></tr>`).join('')}
        ${me.rank > 10 ? `<tr class="mine"><td>${me.rank}</td><td class="user-cell">${avatar(me.name, 22)}<span>${esc(me.name)} (you)</span></td><td>${money(me.wagered)}</td><td class="muted">wager ${fmt(Math.max(0, list[9].wagered - me.wagered + 0.01))} more for top 10</td></tr>` : ''}
      </tbody></table></div></div>
      <div class="panel"><div class="panel-head"><h2>Yesterday's winners</h2></div><div class="prev-winners">${prev.map(p => `<div class="prev">${avatar(p.name, 30)}<div><b>${esc(p.name)}</b><span class="muted small">#${p.rank} · ${money(p.prize)}</span></div></div>`).join('')}</div></div>`;
  };
  const tick = () => {
    const ms = msToReset(), cd = $('#cd', el);
    if (!cd) return;
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    cd.innerHTML = `<span class="muted small">Ends in</span><b>${pad(h)}<small>h</small> ${pad(m)}<small>m</small> ${pad(s)}<small>s</small></b>`;
  };
  draw(); tick();
  const t1 = setInterval(tick, 1000), t2 = setInterval(() => { draw(); tick(); }, 20000);
  return () => { clearInterval(t1); clearInterval(t2); };
}
