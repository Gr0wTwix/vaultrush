// Simulated chat with coin rain. A real site would run this over WebSockets.
import { state, credit, logTx, save, emit } from './state.js';
import { randomBot } from './data.js';
import { shownName } from './feed.js';
import { $, $$, esc, fmt, avatar, icon, coin, toast, h } from './ui.js';
import { sfx } from './sfx.js';
import { getPool } from './views/double.js';

const LINES = ['gl everyone', 'that crash went to 40x wtf', 'blade vault is rigged against me lol', 'finally hit a knife!!', 'who wants to battle?', 'rain soon?', 'mines 3 bombs is the way', 'upgrade 10% hit first try', 'lost 5 in a row, taking a break', 'gg', 'starter crate carrying', 'w', 'cashed out at 2x, safe', 'need one more legendary', 'crazy mode battles are fun', 'who pulled the Starforged??'];
const levelOf = n => 5 + (n.length * 7) % 60;

export function initChat(root) {
  root.innerHTML = `
    <div class="chat-head"><div class="chat-title">${icon('chat')} Chat</div><div class="online"><span class="live-dot"></span><b id="onlineCount">412</b> online</div></div>
    <div class="rain" id="rain" hidden></div>
    <a class="pool-promo" href="#/double" id="poolPromo"><div><b>Triple Green</b><span>Here's your chance for the <b id="poolAmt"></b> pool!</span></div><span class="btn btn-primary btn-sm">Play Double</span></a>
    <div class="chat-msgs" id="chatMsgs"></div>
    <form class="chat-form" id="chatForm"><input id="chatInput" maxlength="140" placeholder="Say something…" autocomplete="off"><button class="btn btn-primary" type="submit">Send</button></form>`;
  const box = $('#chatMsgs', root);

  const add = (user, text, sys = false) => {
    if (!sys && user !== state.name && state.blocked.includes(user)) return;
    const el = h(sys
      ? `<div class="msg msg-sys">${text}</div>`
      : `<div class="msg">${avatar(shownName(user), 26)}<div><div class="msg-user"><span class="lvl">${levelOf(user)}</span><span class="msg-name" data-u="${esc(user)}">${esc(shownName(user))}</span></div><div class="msg-text">${esc(text)}</div></div></div>`);
    if (!sys) emit('chatmsg', user);
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.append(el);
    while (box.children.length > 60) box.firstElementChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  };

  // Click a name to ignore that player (manage the list under Account > Options).
  box.addEventListener('click', e => {
    const n = e.target.closest('.msg-name'); if (!n || n.dataset.u === state.name) return;
    if (!confirm(`Ignore ${n.dataset.u}? Their messages will be hidden.`)) return;
    state.blocked.push(n.dataset.u); save();
    $$('.msg-name', box).forEach(x => { if (x.dataset.u === n.dataset.u) x.closest('.msg').remove(); });
    toast(`Ignoring ${n.dataset.u}`);
  });

  for (let i = 0; i < 8; i++) add(randomBot(), LINES[Math.floor(Math.random() * LINES.length)]);
  add('', `Welcome to Vaultrush! Everything here is <b>play money</b>.`, true);

  const botTalk = () => { add(randomBot(), LINES[Math.floor(Math.random() * LINES.length)]); setTimeout(botTalk, 3500 + Math.random() * 6000); };
  setTimeout(botTalk, 3000);

  $('#chatForm', root).onsubmit = e => {
    e.preventDefault();
    const v = $('#chatInput', root).value.trim();
    if (!v) return;
    add(state.name, v); $('#chatInput', root).value = '';
    box.scrollTop = box.scrollHeight;
  };

  let online = 412;
  setInterval(() => { online = Math.max(250, online + Math.round((Math.random() - 0.5) * 14)); const el = $('#onlineCount'); if (el) el.textContent = online; }, 4000);

  // Promo card for the Double pool (keeps the live pool amount up to date).
  const drawPool = () => { const a = $('#poolAmt', root); if (a) a.innerHTML = `${coin()}${fmt(getPool())}`; };
  drawPool(); setInterval(drawPool, 3000);

  // Coin rain: join within 30s, then the pot is split between joiners.
  const rainEl = $('#rain', root);
  const startRain = () => {
    const pot = 20 + Math.round(Math.random() * 30);
    let left = 30, joined = false;
    rainEl.hidden = false;
    const draw = () => {
      rainEl.innerHTML = `<div class="rain-info"><b>Coin rain</b><span>${coin()}${fmt(pot)} · ${left}s</span></div><button class="btn ${joined ? 'btn-ghost' : 'btn-primary'}" ${joined ? 'disabled' : ''}>${joined ? 'Joined' : 'Join'}</button>`;
      rainEl.querySelector('button').onclick = () => { joined = true; sfx.click(); draw(); };
    };
    draw();
    const t = setInterval(() => {
      left--; draw();
      if (left <= 0) {
        clearInterval(t); rainEl.hidden = true;
        if (joined) {
          const share = Math.round((1 + Math.random() * 3) * 100) / 100;
          credit(share); logTx('Coin rain', share); sfx.win();
          toast(`Coin rain: +${fmt(share)}`, 'win');
          add('', `${coin()} Rain paid out ${fmt(pot)} to 14 players. You got <b>${fmt(share)}</b>.`, true);
        } else add('', `${coin()} Rain paid out ${fmt(pot)} to 13 players.`, true);
        setTimeout(startRain, 150000);
      }
    }, 1000);
  };
  setTimeout(startRain, 40000);
}
