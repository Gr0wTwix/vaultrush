import { CASES, ITEMS, RARITY } from '../data.js';
import { bets, drops } from '../feed.js';
import { state, save, on, levelFromXp, xpForLevel, isAuthed } from '../state.js';
import { $, $$, esc, fmt, money, icon, avatar, caseArt, itemArt } from '../ui.js';
import { eyeBtn } from '../preview.js';
import { applyUi } from '../account.js';

// [href, icon, name, tagline, hook, css class]
const GAMES = [
  ['#/battles', 'battles', 'Battles', 'Up to 6 players, 7 modes', 'Winner takes all', 'g-battles'],
  ['#/cases', 'cases', 'Cases', 'Unbox original collectibles', `${CASES.length} cases`, 'g-cases'],
  ['#/crash', 'crash', 'Crash', 'Cash out before it busts', 'Up to 1000×', 'g-crash'],
  ['#/double', 'double', 'Double', 'Purple, gray or green', 'Win up to 14×', 'g-double'],
  ['#/plinko', 'plinko', 'Plinko', 'Drop and bounce', '3 risk levels', 'g-plinko'],
  ['#/upgrade', 'upgrade', 'Upgrade', 'Risk it for a better item', 'Pick your odds', 'g-upgrade'],
  ['#/mines', 'mines', 'Mines', "Don't hit the bomb", 'Up to 8×8 grids', 'g-mines'],
  ['#/coinflip', 'coin', 'Coinflip', 'Head to head, 3D toss', 'PvP', 'g-coin'],
];

const ART = { coin: 'coinflip' };   // icon name -> artwork file in assets/home

const HOW = [
  [1, 'Choose a game', 'Browse the game modes or inspect a case and its drop odds.', 'cases'],
  [2, 'Use play coins', 'Try the demo with virtual coins that cannot be bought or withdrawn.', 'coin'],
  [3, 'Review the outcome', 'Inspect your round history and explore the fairness information.', 'fair'],
];
const FAQ = [
  ['Is Vaultrush a real-money site?', 'No. Vaultrush is a play-money demo. Coins have no cash value and cannot be bought or withdrawn.'],
  ['Are the collectibles real CS2 or Rust skins?', 'No. These are original virtual collectibles created for the Vaultrush demo, not transferable CS2 or Rust inventory items.'],
  ['Where can I see the odds?', 'Open a case to inspect its listed items, drop chances and ticket ranges before using play coins.'],
  ['How do I check a result is fair?', 'Before you play, the site shows the hash of a secret server seed. When you rotate seeds the secret is revealed, and the Fairness page recomputes every bet made with it. In this demo the seeds live in your browser, so it shows the method rather than a trusted third party.'],
  ['Are the other players and the chat real?', 'No. The live drops, live bets, open battles, coin rain and chat messages are simulated demo activity. Your own bets, balance and history are real inside the demo and saved in this browser.'],
];

export function betRow(b) {
  const win = b.payout > 0;
  return `<tr class="${b.mine ? 'mine' : ''}"><td>${esc(b.game)}</td><td class="user-cell">${avatar(b.user, 22)}<span>${esc(b.user)}</span></td><td>${money(b.amount)}</td><td class="${win ? 'pos' : 'neg'}">${fmt(b.multi)}×</td><td class="${win ? 'pos' : 'neg'}">${win ? money(b.payout) : `<span class="money">-${fmt(b.amount)}</span>`}</td></tr>`;
}

const legends = [...ITEMS].sort((a, b) => b.value - a.value).slice(0, 5);

export function render(el) {
  const featured = [0, 3, 6, 10, 14].map(i => CASES[i % CASES.length]);
  const slides = [
    { cls: 's-vault', eyebrow: `${icon('bolt')} Play-money skin arena`, title: 'Open. Battle.<br><span class="grad">Rush the vault.</span>', text: 'Cases, battles, crash, upgrades and mines. Every result is provably fair, and you start with 100 free coins.',
      cta: '<a class="btn btn-primary btn-lg" href="#/cases">Open a case</a><a class="btn btn-ghost btn-lg" href="#/battles/create">Start a battle</a>',
      art: `<div class="hm-cases">${featured.map((c, i) => `<a href="#/case/${c.id}" class="float-case f${i}">${caseArt(c)}</a>`).join('')}</div>` },
    { cls: 's-legend', eyebrow: `${icon('star')} Chase the legends`, title: `${CASES.length} cases.<br><span class="grad gold">${ITEMS.length} skins.</span>`, text: 'From starter crates to knife-tier vaults. Peek inside any case with the eye button before you open it.',
      cta: '<a class="btn btn-primary btn-lg" href="#/cases">Browse cases</a>',
      art: `<div class="hm-items">${legends.map((it, i) => `<div class="hm-item i${i}" style="--rc:${RARITY[it.rarity].color}"><div class="hm-glow"></div>${itemArt(it)}<b>${fmt(it.value)}</b></div>`).join('')}</div>` },
    { cls: 's-mines', eyebrow: `${icon('mines')} Original`, title: 'Mines.<br><span class="grad">Find the gems.</span>', text: 'Pick a grid from 4×4 up to 8×8, choose your mines and cash out whenever you like. One wrong tile and the bet is gone.',
      cta: '<a class="btn btn-primary btn-lg" href="#/mines">Play Mines</a>',
      art: `<div class="hm-mines">${['', 'g', '', 'g', '', '', 'g', '', 'g', 'b', 'g', '', '', 'g', '', '', 'g', 'g'].map(c => `<i class="${c}"></i>`).join('')}</div>` },
  ];

  const lvl = levelFromXp(state.xp), base = xpForLevel(lvl), next = xpForLevel(lvl + 1);
  const pct = Math.max(0, Math.min(100, ((state.xp - base) / (next - base)) * 100));

  el.innerHTML = `
    ${isAuthed() ? `    <section class="hm-welcome">
      ${avatar(state.name, 44)}
      <div class="hm-who"><span class="muted small">Welcome back</span><b>${esc(state.name)}</b></div>
      <div class="hm-level"><span class="hm-lvl">LVL ${lvl}</span><div class="hm-bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="muted small">${Math.round(next - state.xp).toLocaleString('en-US')} XP to level ${lvl + 1}</span></div>
      <div class="hm-welcome-cta"><a class="btn btn-ghost" href="#/rewards">${icon('gift')} Rewards</a><a class="btn btn-ghost" href="#/leaderboard">${icon('trophy')} Race</a></div>
    </section>` : ''}

    <section class="hm-car" id="car" aria-roledescription="carousel">
      ${slides.map((s, i) => `<article class="hm-slide ${s.cls} ${i ? '' : 'on'}"><div class="hm-copy"><span class="eyebrow">${s.eyebrow}</span><h1>${s.title}</h1><p>${s.text}</p><div class="hero-cta">${s.cta}</div></div><div class="hm-art">${s.art}</div></article>`).join('')}
      <button class="hm-nav prev" aria-label="Previous slide">‹</button><button class="hm-nav next" aria-label="Next slide">›</button>
      <div class="hm-dots">${slides.map((_, i) => `<button class="${i ? '' : 'on'}" aria-label="Slide ${i + 1}"></button>`).join('')}</div>
    </section>

    <h2 class="section-title">Our games</h2>
    <section class="hm-games">
      ${GAMES.map(([href, ic, name, sub, hook, cls]) => `<a class="hm-game ${cls}" href="${href}" title="${sub}">
        <span class="hm-hook">${hook}</span>
        <div class="hm-gicon"><img src="assets/home/${ART[ic] || ic}.webp" alt="" loading="lazy" decoding="async"></div>
        <div class="hm-gtext"><b>${name}</b></div></a>`).join('')}
    </section>

    <section class="perks">
      <a class="perk" href="#/rewards">${icon('gift')}<div><b>3 free cases</b><span>Welcome gift, plus a daily case</span></div></a>
      <a class="perk" href="#/rewards">${icon('star')}<div><b>Rakeback & levels</b><span>Every bet earns XP and coins back</span></div></a>
      <a class="perk" href="#/leaderboard">${icon('trophy')}<div><b>Daily race</b><span>1,000 coins for the top 10</span></div></a>
      <a class="perk" href="#/fair">${icon('fair')}<div><b>Provably fair</b><span>Check any bet yourself</span></div></a>
    </section>

    <div class="panel-head" style="margin:0"><h2 class="section-title">Popular cases</h2><a class="small" href="#/cases">View all ${CASES.length} cases →</a></div>
    <section class="case-grid">${CASES.slice(0, 12).map(c => `<a class="case-card" href="#/case/${c.id}" data-case="${c.id}" style="--hue:${c.hue}">${eyeBtn(c.id)}${caseArt(c)}<b>${esc(c.name)}</b>${money(c.price, 'price')}</a>`).join('')}</section>

    <section class="hm-two">
      <div class="panel">
        <div class="panel-head"><h2>Highlights</h2><span class="muted small">Biggest recent drops <span class="tag demo">Demo</span></span></div>
        <div class="hl-list" id="hl"></div>
      </div>
      <div class="hm-events">
        <h2 class="section-title">Events</h2>
        <a class="hm-event e-race" href="#/leaderboard">${icon('trophy')}<div><b>Daily race</b><span>Top 10 wagerers split 1,000 coins</span></div><em>Join</em></a>
        <a class="hm-event e-free" href="#/rewards">${icon('gift')}<div><b>Free crates</b><span>Daily case, level cases and rakeback</span></div><em>Claim</em></a>
        <a class="hm-event e-fair" href="#/fair">${icon('fair')}<div><b>House-edge test</b><span>Simulate a million rounds in your browser</span></div><em>Run</em></a>
      </div>
    </section>

    <section class="hm-how" id="how-it-works">
      <div class="panel-head"><h2>How it works</h2><span class="muted small">Three steps, no deposits</span></div>
      <div class="hm-how-grid">${HOW.map(([n, t, d, ic]) => `<div class="hm-step"><span class="hm-step-n">${n}</span><div class="hm-step-ic">${icon(ic)}</div><b>${t}</b><p>${d}</p></div>`).join('')}</div>
    </section>

    <div class="panel">
      <div class="panel-head"><h2>Live bets <span class="tag demo">Demo activity</span></h2><div class="tabs" id="betTabs"><button class="tab active" data-f="all">All bets</button><button class="tab" data-f="high">High rollers</button><button class="tab" data-f="lucky">Lucky wins</button><button class="tab" data-f="mine">My bets</button></div></div>
      <div class="table-wrap"><table class="bets"><thead><tr><th>Game</th><th>User</th><th>Bet</th><th>Multi</th><th>Payout</th></tr></thead><tbody id="betRows"></tbody></table></div>
    </div>
    <section class="hm-info">
      <div class="panel hm-faq"><div class="panel-head"><h2>Questions</h2><span class="muted small">About this demo</span></div>
        ${FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div>
      <div class="hm-community">
        <img src="assets/home/community.webp" alt="" loading="lazy" decoding="async">
        <span class="eyebrow">${icon('chat')} Live chat</span>
        <h2>Join the conversation.</h2>
        <p>Say something, grab the coin rain when it drops, and click a name to ignore someone. Chat messages and the other players are simulated demo activity.</p>
        <button class="btn btn-primary btn-lg" id="openChat">Open chat</button>
      </div>
    </section>`;

  // ---- carousel ----
  const car = $('#car', el), slideEls = $$('.hm-slide', car), dots = $$('.hm-dots button', car);
  let cur = 0, timer = 0;
  const go = n => {
    cur = (n + slideEls.length) % slideEls.length;
    slideEls.forEach((s, i) => s.classList.toggle('on', i === cur));
    dots.forEach((d, i) => d.classList.toggle('on', i === cur));
  };
  const auto = () => { clearInterval(timer); timer = window.setInterval(() => go(cur + 1), 6500); };
  $('.prev', car).onclick = () => { go(cur - 1); auto(); };
  $('.next', car).onclick = () => { go(cur + 1); auto(); };
  dots.forEach((d, i) => d.onclick = () => { go(i); auto(); });
  car.onmouseenter = () => clearInterval(timer);
  car.onmouseleave = auto;
  auto();

  // ---- highlights: the most valuable recent drops ----
  const drawHl = () => {
    const top = [...drops].sort((a, b) => b.item.value - a.item.value).slice(0, 6);
    $('#hl', el).innerHTML = top.map(d => `<div class="hl-row" style="--rc:${RARITY[d.item.rarity].color}">
      <div class="hl-art">${itemArt(d.item)}</div>
      <div class="hl-info"><b>${d.item.st ? '<span class="st">ST</span> ' : ''}${esc(d.item.weapon)} <span class="muted">|</span> ${esc(d.item.skin)}</b><span class="muted small">${avatar(d.user, 16)} ${esc(d.user)} · from ${esc(d.source)}</span></div>
      <div class="hl-val">${money(d.item.value)}</div></div>`).join('') || '<p class="muted">Waiting for drops…</p>';
  };
  drawHl();

  // ---- live bets ----
  let filter = 'all';
  const draw = () => {
    const rows = bets.filter(b => filter === 'all' || (filter === 'high' ? b.amount >= 25 : filter === 'mine' ? b.mine : b.multi >= 3)).slice(0, 12);
    $('#betRows', el).innerHTML = rows.map(betRow).join('') || '<tr><td colspan="5" class="muted">No bets yet</td></tr>';
  };
  $$('#betTabs .tab', el).forEach(t => t.onclick = () => { $$('#betTabs .tab', el).forEach(x => x.classList.toggle('active', x === t)); filter = t.dataset.f; draw(); });
  draw();
  $('#openChat', el).onclick = () => {
    if (!state.ui.chat) { state.ui.chat = true; save(); applyUi(); }
    document.body.classList.add('chat-open');
    setTimeout(() => $('#chatInput')?.focus(), 50);
  };
  const offBet = on('bet', draw), offDrop = on('drop', drawHl);
  return () => { clearInterval(timer); offBet(); offDrop(); };
}
