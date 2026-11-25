// Chat with coin rain. Signed in with live games on, it is the real shared chat (Supabase realtime); otherwise it is simulated.
import { state, credit, logTx, save, emit, on, requireLogin } from './state.js';
import { isLive, recentChat, sendChat, watchChat, onOnline, chatStatus, reportChat, type ChatRow } from './live.js';
import { joinRain, rainNow, watchRains } from './events.js';
import { hasStoredSession } from './backend.js';
import { randomBot } from './data.js';
import { shownName } from './feed.js';
import { $, $$, esc, fmt, avatar, icon, coin, toast, h } from './ui.js';
import { sfx } from './sfx.js';
import { getPool } from './views/double.js';

const LINES = ['gl everyone', 'that crash went to 40x wtf', 'blade vault is rigged against me lol', 'finally hit a knife!!', 'who wants to battle?', 'rain soon?', 'mines 3 bombs is the way', 'upgrade 10% hit first try', 'lost 5 in a row, taking a break', 'gg', 'starter crate carrying', 'w', 'cashed out at 2x, safe', 'need one more legendary', 'crazy mode battles are fun', 'who pulled the Starforged??'];
const levelOf = n => 5 + (n.length * 7) % 60;

export function initChat(root) {
  root.innerHTML = `
    <div class="chat-head"><div class="chat-title">${icon('chat')} Chat</div><div class="online"><span class="live-dot"></span><b id="onlineCount">…</b> online</div></div>
    <div class="rain" id="rain" hidden></div>
    <a class="pool-promo" href="#/double" id="poolPromo"><div><b>Triple Green</b><span>Here's your chance for the <b id="poolAmt"></b> pool!</span></div><span class="btn btn-primary btn-sm">Play Double</span></a>
    <div class="chat-pin" id="chatPin" hidden></div>
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

  // A real player's message (live chat): staff messages carry a badge, removed ones say so, others can be reported.
  const REMOVED = '<i class="msg-removed">Message removed by a moderator</i>';
  const addLive = (m: ChatRow): void => {
    const user = m.display_name;
    if (user !== state.name && state.blocked.includes(user)) return;
    const own = user === state.name, removed = !!m.removed_at;
    const el = h(`<div class="msg ${m.is_staff ? 'msg-staff' : ''}" data-id="${Number(m.id)}">${avatar(shownName(user), 26)}<div class="msg-body"><div class="msg-user"><span class="lvl">${levelOf(user)}</span><span class="msg-name" data-u="${esc(user)}">${esc(shownName(user))}</span>${m.is_staff ? '<span class="staff-badge">STAFF</span>' : ''}
      ${own || m.is_staff || removed ? '' : `<button class="msg-report" type="button" aria-label="Report this message from ${esc(shownName(user))}" title="Report">${icon('report')}</button>`}</div><div class="msg-text">${removed ? REMOVED : esc(m.body)}</div></div></div>`);
    emit('chatmsg', user);
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.append(el);
    while (box.children.length > 60) box.firstElementChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  };
  /** A moderator removed a message: it changes for everyone at once. */
  const changeLive = (m: ChatRow): void => {
    const el = box.querySelector(`.msg[data-id="${Number(m.id)}"]`); if (!el || !m.removed_at) return;
    const t = el.querySelector('.msg-text'); if (t) t.innerHTML = REMOVED;
    el.querySelector('.msg-report')?.remove();
    void drawPin();
  };
  // The pinned message and the room state, asked again every minute while the live chat is on.
  let pinT: ReturnType<typeof setInterval> | undefined;
  const drawPin = async (): Promise<void> => {
    const s = isLive() ? await chatStatus() : null, pin = $('#chatPin', root);
    if (!pin) return;
    pin.hidden = !s?.pinned && !s?.locked && !s?.slow_seconds;
    pin.innerHTML = s ? `${s.pinned ? `<div class="pin-msg">${icon('report')}<b>${esc(s.pinned.display_name)}${s.pinned.is_staff ? ' <span class="staff-badge">STAFF</span>' : ''}</b> ${esc(s.pinned.body)}</div>` : ''}${s.locked ? '<div class="pin-note">The chat is closed for a moment. Only staff can write.</div>' : s.slow_seconds ? `<div class="pin-note">Slow mode: one message every ${s.slow_seconds} seconds.</div>` : ''}` : '';
  };

  // Click a name to ignore that player (manage the list under Account > Options).
  box.addEventListener('click', e => {
    const rep = e.target.closest('.msg-report');
    if (rep) {
      const id = Number(rep.closest('.msg')?.dataset.id);
      if (!id || !requireLogin('Log in to report a message.')) return;
      if (!confirm('Report this message to the moderators?')) return;
      reportChat(id).then(() => { toast('Reported. Thank you, a moderator will look at it.'); rep.remove(); }).catch(err => toast(err instanceof Error ? err.message : 'Could not report', 'error'));
      return;
    }
    const n = e.target.closest('.msg-name'); if (!n || n.dataset.u === state.name) return;
    if (!confirm(`Ignore ${n.dataset.u}? Their messages will be hidden.`)) return;
    state.blocked.push(n.dataset.u); save();
    $$('.msg-name', box).forEach(x => { if (x.dataset.u === n.dataset.u) x.closest('.msg').remove(); });
    toast(`Ignoring ${n.dataset.u}`);
  });

  let botT: ReturnType<typeof setTimeout> | undefined, onlineT: ReturnType<typeof setInterval> | undefined, rainT: ReturnType<typeof setTimeout> | undefined, fallbackT: ReturnType<typeof setTimeout> | undefined;
  let online = 412, simulated = false;
  const botTalk = () => { if (isLive()) return; add(randomBot(), LINES[Math.floor(Math.random() * LINES.length)]); botT = setTimeout(botTalk, 3500 + Math.random() * 6000); };
  /** The simulated room: bot chatter, a drifting online count, coin rain. Only for visitors with no live chat to show. */
  const startSimulated = (): void => {
    if (simulated || isLive()) return;
    simulated = true; clearTimeout(fallbackT);
    box.innerHTML = '';
    for (let i = 0; i < 8; i++) add(randomBot(), LINES[Math.floor(Math.random() * LINES.length)]);
    add('', `Welcome to Vaultrush! Everything here is <b>play money</b>.`, true);
    botT = setTimeout(botTalk, 3000);
    const el = $('#onlineCount', root); if (el) el.textContent = String(online);
    onlineT = setInterval(() => { online = Math.max(250, online + Math.round((Math.random() - 0.5) * 14)); const e = $('#onlineCount', root); if (e) e.textContent = String(online); }, 4000);
    rainT = setTimeout(startRain, 40000);
  };

  $('#chatForm', root).onsubmit = e => {
    e.preventDefault();
    const v = $('#chatInput', root).value.trim();
    if (!v) return;
    if (isLive()) {
      // The server puts your profile name on the message, so Anonymous mode cannot hide it here.
      if (state.ui.anonymous) return toast('Turn off Anonymous mode (Account > Options) to chat with other players: your name shows on the message.', 'error');
      $('#chatInput', root).value = '';
      sendChat(v).catch(err => toast(err instanceof Error ? err.message : 'Could not send', 'error'));
      return;                                   // it appears when the server echoes it back, like everyone else's
    }
    add(state.name, v); $('#chatInput', root).value = '';
    box.scrollTop = box.scrollHeight;
  };

  // Promo card for the Double pool (keeps the live pool amount up to date).
  const drawPool = () => { const a = $('#poolAmt', root); if (a) a.innerHTML = `${coin()}${fmt(getPool())}`; };
  drawPool(); setInterval(drawPool, 3000);

  // Coin rain: join within 30s, then the pot is split between joiners.
  const rainEl = $('#rain', root);
  const startRain = () => {
    if (isLive()) return;                       // coin rain is a simulation: not shown next to real players
    const pot = 20 + Math.round(Math.random() * 30);
    let left = 30, joined = false;
    rainEl.hidden = false;
    const draw = () => {
      rainEl.innerHTML = `<div class="rain-info"><b>Coin rain</b><span>${coin()}${fmt(pot)} · ${left}s</span></div><button class="btn ${joined ? 'btn-ghost' : 'btn-primary'}" ${joined ? 'disabled' : ''}>${joined ? 'Joined' : 'Join'}</button>`;
      rainEl.querySelector('button').onclick = () => { if (!requireLogin('Log in or create a free account to join the coin rain.')) return; joined = true; sfx.click(); draw(); };
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

  // Real coin rain (migration 0024): staff start it; signed-in players join here; when time is up the database splits the pot and pays it.
  let rainTick: ReturnType<typeof setInterval> | undefined, rainPoll: ReturnType<typeof setInterval> | undefined, stopRains: (() => void) | null = null;
  const seenOpen = new Set<number>(), paidShown = new Set<number>();
  const drawLiveRain = async (): Promise<void> => {
    clearInterval(rainTick);
    const r = isLive() ? await rainNow() : null;
    if (!r) { rainEl.hidden = true; return; }
    if (r.last && seenOpen.has(r.last.id) && !paidShown.has(r.last.id)) {
      paidShown.add(r.last.id);
      add('', r.last.joiners ? `${coin()} Coin rain paid ${fmt(r.last.pot)} to ${r.last.joiners} player${r.last.joiners === 1 ? '' : 's'}${r.last.mine ? `. You got <b>${fmt(r.last.share)}</b>` : ''}.` : `${coin()} Coin rain ended: nobody joined.`, true);
      if (r.last.mine) { sfx.win(); toast(`Coin rain: +${fmt(r.last.share)}`, 'win'); }
    }
    const o = r.open;
    if (!o) { rainEl.hidden = true; return; }
    seenOpen.add(o.id);
    const skew = r.now - Date.now(), end = Date.parse(o.ends_at);
    let joined = o.joined, joiners = o.joiners;
    const draw = (): void => {
      const left = Math.max(0, Math.ceil((end - (Date.now() + skew)) / 1000));
      rainEl.hidden = false;
      rainEl.innerHTML = `<div class="rain-info"><b>Coin rain</b><span>${coin()}${fmt(o.pot)} · ${left}s · ${joiners} joined${o.min_level ? ` · level ${o.min_level}+` : ''}</span></div><button class="btn ${joined ? 'btn-ghost' : 'btn-primary'}" ${joined || left === 0 ? 'disabled' : ''}>${joined ? 'Joined' : 'Join'}</button>`;
      rainEl.querySelector('button').onclick = async () => {
        if (!requireLogin('Log in or create a free account to join the coin rain.')) return;
        try { const j = await joinRain(o.id); joined = true; joiners = j.joiners; sfx.click(); draw(); } catch (err) { toast(err instanceof Error ? err.message : 'Could not join', 'error'); }
      };
      if (left === 0) { clearInterval(rainTick); setTimeout(() => void drawLiveRain(), 1500); }          // asking again settles and pays it
    };
    draw(); rainTick = setInterval(draw, 1000);
  };
  const stopLiveRain = (): void => { clearInterval(rainTick); clearInterval(rainPoll); stopRains?.(); stopRains = null; rainEl.hidden = true; };

  // Live games switched on (or off): swap the simulated chat for the real one.
  let stopChat: (() => void) | null = null, stopOnline: (() => void) | null = null;
  const goLive = async (): Promise<void> => {
    stopChat?.(); stopOnline?.(); stopChat = stopOnline = null;
    clearInterval(pinT); const pinBox = $('#chatPin', root); if (pinBox) pinBox.hidden = true;
    stopLiveRain();
    if (!isLive()) return;
    clearTimeout(botT); clearInterval(onlineT); clearTimeout(rainT); clearTimeout(fallbackT); simulated = false; rainEl.hidden = true;
    box.innerHTML = '';
    add('', 'Live chat: these are real players. Everything here is <b>play money</b>.', true);
    try { (await recentChat(30)).forEach(addLive); } catch { add('', 'Could not load earlier messages.', true); }
    stopChat = await watchChat(addLive, changeLive).catch(() => null);
    clearInterval(pinT); void drawPin(); pinT = setInterval(() => void drawPin(), 60_000);
    void drawLiveRain(); rainPoll = setInterval(() => void drawLiveRain(), 60_000);
    stopRains = await watchRains(() => void drawLiveRain()).catch(() => null);
    stopOnline = onOnline(n => { const el = $('#onlineCount'); if (el) el.textContent = String(Math.max(1, n)); });
  };
  on('live', () => { void goLive(); });
  if (isLive()) void goLive();
  else if (hasStoredSession()) {
    // A saved sign-in: the real chat is about to switch on. Show a quiet "connecting" line, not the bots, and fall back to the simulated room only if it does not.
    box.innerHTML = '<div class="msg msg-sys chat-connecting">Connecting to the live chat…</div>';
    fallbackT = setTimeout(startSimulated, 6000);
    on('auth', signedIn => { if (!signedIn) startSimulated(); });
  } else startSimulated();
}
