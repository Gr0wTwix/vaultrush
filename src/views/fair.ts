import { CASES, REWARD_CASES, CASE, ticketOf, entryForTicket } from '../data.js';
import { getFair, setClientSeed, rotate, sha256, floatsFor, crashPoint, minePositions, doubleRoll, doubleColor, plinkoPath, plinkoTable, HOUSE } from '../fair.js';
import { verifyAll, rtpTest, uniformityTest, SNIPPET } from '../verify.js';
import { $, $$, esc, fmt, icon, toast } from '../ui.js';
import { isAuthed, requireLogin } from '../state.js';

const GAMES = [['crash', 'Crash'], ['double', 'Double'], ['cases', 'Case opening'], ['battles', 'Case battles'], ['mines', 'Mines'], ['plinko', 'Plinko'], ['coinflip', 'Coinflip'], ['upgrade', 'Upgrade roll']];
const pct = x => `${(x * 100).toFixed(2)}%`;
const edge = rtp => `${((1 - rtp) * 100).toFixed(2)}%`;

// How every mode turns the roll into a result (the same text sits next to the verifier so it can be checked by hand).
const MODES = [
  ['Case opening & free crates', 'cases', `Roll → <b>ticket 0–99,999</b> (<code>⌊roll × 100,000⌋</code>). Every item owns a ticket range shown on the case page; the range that contains your ticket is the drop. Case prices are set so expected value ÷ price = <b>${pct(HOUSE.cases)}</b>.`, HOUSE.cases],
  ['Case battles', 'battles', `One bet draws <b>players × rounds + 1</b> rolls. Roll <code>round × players + slot</code> becomes that player's ticket for that round (same ticket ranges as cases). The final extra roll breaks ties and picks the winner in jackpot modes. The pot is paid in full, so the edge is only the case pricing (≈10%).`, HOUSE.cases],
  ['Crash', 'crash', `Roll → <code>max(1, ⌊${100 * HOUSE.crash} ÷ (1 − roll)⌋ ÷ 100)</code>. The ${pct(1 - HOUSE.crash)} edge comes from the ${100 * HOUSE.crash} in the numerator: P(crash ≥ x) = ${HOUSE.crash} ÷ x.`, HOUSE.crash],
  ['Double', 'double', `Roll → <b>tile ⌊roll × 15⌋</b>. Tile 0 is green (14×), odd tiles are purple, even tiles gray (2×), and bait pays 7× on tiles 1 and 14. Every lane returns exactly <b>${pct(HOUSE.double)}</b> (e.g. purple: 7/15 × 2).`, HOUSE.double],
  ['Mines', 'mines', `<b>tiles − 1</b> rolls drive a Fisher–Yates shuffle of the tiles; the first <i>mines</i> tiles after shuffling are the bombs. Multiplier = ${HOUSE.mines} × Π (tiles − i) ÷ (safe tiles − i), rounded down to 2 decimals (≈${edge(0.9642)} edge at 3 gems).`, HOUSE.mines],
  ['Plinko', 'plinko', `One roll per row: <b>roll ≥ 0.5 → bounce right</b>. The bucket is the number of rights. Multipliers are scaled so the average over the binomial distribution is ${pct(HOUSE.plinko)} (≈3.1% edge after rounding).`, HOUSE.plinko],
  ['Coinflip', 'coinflip', `Roll &lt; 0.5 → <b>Bolt</b>, otherwise <b>Star</b>. The winner takes the pot minus ${pct(1 - HOUSE.coinflip)}.`, HOUSE.coinflip],
  ['Upgrade', 'upgrade', `Chance = stake ÷ target × ${HOUSE.upgrade} (capped at 80%). <b>Under</b> wins if roll &lt; chance; <b>over</b> wins if roll &gt; 1 − chance. The pointer lands exactly at <code>roll × 360°</code>.`, HOUSE.upgrade],
];

export function render(el) {
  let rtpRows = null, uni = null;

  const draw = async () => {
    const f = getFair();
    const revealed = f.revealed;
    el.innerHTML = `
      <div class="page-head"><h1>${icon('fair')} Provably fair</h1><p class="muted">Every result is produced by <code>HMAC_SHA256(serverSeed, clientSeed:nonce:round)</code> from a seed we committed to <b>before</b> you played. Rotate to reveal the seed, then re-check any bet below, in the verifier, or with the standalone code.</p></div>

      <div class="panel pf-loop">
        <div class="pf-step"><b>1 · Commit</b><span>Server seed is hashed (SHA-256) and the hash is shown to you first.</span></div>
        <div class="pf-arrow">→</div>
        <div class="pf-step"><b>2 · Play</b><span>Your client seed + a nonce counter join the secret seed for every bet.</span></div>
        <div class="pf-arrow">→</div>
        <div class="pf-step"><b>3 · Reveal</b><span>Rotate and the old server seed is published.</span></div>
        <div class="pf-arrow">→</div>
        <div class="pf-step"><b>4 · Check</b><span>Hash it again: it must equal the hash from step 1. Then recompute every bet.</span></div>
      </div>

      <div class="fair-grid">
        ${isAuthed() ? `        <div class="panel">
          <div class="panel-head"><h2>Your seeds</h2></div>
          <div class="field"><label>Active server seed hash (SHA-256)</label><div class="mono box">${f.serverHash}</div></div>
          <div class="field"><label>Next server seed hash <span class="tag">committed</span></label><div class="mono box">${f.next.serverHash}</div><span class="muted small">This seed is already fixed. It becomes active when you rotate, so it cannot be chosen after seeing your bets.</span></div>
          <div class="field"><label>Client seed</label><div class="amount"><input id="cs" value="${esc(f.clientSeed)}" maxlength="64"><button id="csSave">Save</button></div><span class="muted small">Changing it mid-pair is safe: each bet records the client seed it used.</span></div>
          <div class="field"><label>Next nonce</label><div class="mono box">${f.nonce}</div></div>
          <button class="btn btn-primary block" id="rot">Rotate &amp; reveal server seed</button>
          ${revealed.length ? `<h3>Revealed seeds</h3><div class="revealed">${revealed.slice(0, 10).map(r => `<div class="rev"><div class="small muted">Server seed (nonces 0–${Math.max(0, r.nonces - 1)}, last client seed <b>${esc(r.clientSeed)}</b>)</div><div class="mono">${r.serverSeed}</div><div class="small muted">Committed hash <span class="mono">${r.serverHash.slice(0, 16)}…</span></div><button class="btn btn-sm btn-ghost use" data-s="${r.serverSeed}" data-c="${esc(r.clientSeed)}">Use in verifier</button></div>`).join('')}</div>` : ''}
        </div>
        ` : `<div class="panel"><div class="panel-head"><h2>Your seeds</h2></div><p class="muted">Your seeds, nonce and revealed history belong to your account. Log in or create a free account to get them.</p><button class="btn btn-primary block" id="seedLogin">Log in / Register</button></div>`}
        <div class="panel">
          <div class="panel-head"><h2>Verifier</h2></div>
          <div class="field"><label>Game</label><select id="vg">${GAMES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <div class="field" id="vcaseF"><label>Case</label><select id="vcase">${[...CASES, ...REWARD_CASES].map(c => `<option value="${c.id}">${esc(c.name)}${c.reward ? ' (free)' : ''}</option>`).join('')}</select></div>
          <div class="field" id="vbatF"><label>Players / case ids (one per round, comma separated)</label><div class="row"><input id="vplayers" type="number" min="2" max="6" value="2" style="width:80px"><input id="vcases" value="starter" class="mono"></div></div>
          <div class="field" id="vminesF"><label>Grid tiles / mines</label><div class="row"><select id="vgrid" style="width:auto">${[16, 25, 36, 49, 64].map(n => `<option ${n === 25 ? 'selected' : ''}>${n}</option>`).join('')}</select><input id="vmines" type="number" min="1" max="63" value="3" style="width:90px"></div></div>
          <div class="field" id="vplinkoF"><label>Rows / risk</label><div class="row"><select id="vrows" style="width:auto">${[8, 10, 12, 14, 16].map(n => `<option ${n === 12 ? 'selected' : ''}>${n}</option>`).join('')}</select><select id="vrisk" style="width:auto"><option>low</option><option selected>normal</option><option>high</option></select></div></div>
          <div class="field"><label>Server seed (revealed)</label><input id="vs" class="mono"></div>
          <div class="field"><label>Client seed</label><input id="vc" class="mono" value="${isAuthed() ? esc(f.clientSeed) : ''}"></div>
          <div class="field"><label>Nonce</label><input id="vn" type="number" min="0" value="0"></div>
          <button class="btn btn-primary block" id="verify">Verify</button>
          <div class="verify-out" id="vout"></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>How each mode uses the roll</h2><span class="muted small">Every game uses the same roll source; only the mapping differs</span></div>
        <div class="pf-modes">${MODES.map(([name, , text, rtp]) => `<div class="pf-mode"><div class="pf-mode-h"><b>${name}</b><span class="tag">RTP ${pct(rtp)} · edge ${edge(rtp)}</span></div><p>${text}</p></div>`).join('')}</div>
        <p class="muted small" style="margin-top:12px">Floats are 4 bytes of the HMAC (32 bits) divided by 2³². Mapping a float to N outcomes with <code>⌊f × N⌋</code> has a bias below 1 in 4 billion × N, which is negligible.</p>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>House edge &amp; randomness check</h2>
          <div class="row"><select id="rtpN" style="width:auto"><option value="50000">50,000 rounds</option><option value="200000" selected>200,000 rounds</option><option value="1000000">1,000,000 rounds</option></select><button class="btn btn-primary btn-sm" id="rtpRun">Run check</button></div></div>
        <p class="muted small">Plays the real game functions many times with fresh random numbers and compares the return-to-player with the exact maths. A mode passes when the simulated value is within 4 standard errors. The same code runs in your browser right now.</p>
        <div class="pf-progress" id="rtpBar" hidden><i></i></div>
        <div id="rtpOut">${rtpRows ? rtpTable(rtpRows) : '<div class="muted small">Not run yet.</div>'}</div>
        <h3>Generator uniformity</h3>
        <div id="uniOut">${uni ? uniView(uni) : '<div class="muted small">Draws 20,000 rolls from the real HMAC generator and runs a chi-square test over 20 bins.</div>'}</div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>Your bet history</h2><div class="row"><span class="muted small" id="histSum"></span><button class="btn btn-ghost btn-sm" id="exp">Export JSON</button></div></div>
        <div class="table-wrap"><table class="bets"><thead><tr><th>Bet ID</th><th>Game</th><th>Nonce</th><th>Server hash</th><th>Result</th><th>Check</th></tr></thead><tbody id="histBody">
          ${f.history.map(b => `<tr><td class="mono">${b.id}</td><td>${b.game}</td><td>${b.nonce}</td><td class="mono small">${b.serverHash.slice(0, 16)}…${b.serverHash === f.serverHash ? ' <span class="tag">active</span>' : ''}</td><td class="small">${esc(b.result || '')}</td><td class="small muted">…</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No bets yet</td></tr>'}
        </tbody></table></div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>Verify without this site</h2><button class="btn btn-ghost btn-sm" id="copyCode">Copy code</button></div>
        <p class="muted small">Paste a revealed server seed and your client seed into this Node script. It needs no libraries and does not talk to Vaultrush.</p>
        <pre class="pf-code"><code>${esc(SNIPPET)}</code></pre>
      </div>`;

    // ---- seeds
    if (!isAuthed()) $('#seedLogin', el).onclick = () => requireLogin('Log in or create a free account to get your own seeds.');
    else $('#csSave', el).onclick = () => { setClientSeed($('#cs', el).value.trim()); toast('Client seed saved'); draw(); };
    if (isAuthed()) $('#rot', el).onclick = async () => { await rotate(); toast('Server seed revealed and rotated'); draw(); };
    $$('.use', el).forEach(b => b.onclick = () => { $('#vs', el).value = b.dataset.s; $('#vc', el).value = b.dataset.c; $('#vs', el).scrollIntoView({ block: 'center' }); });
    $('#copyCode', el).onclick = () => { navigator.clipboard?.writeText(SNIPPET).then(() => toast('Code copied'), () => toast('Select the code and copy it', 'error')); };
    $('#exp', el).onclick = () => {
      const data = JSON.stringify({ note: 'Vaultrush play-money demo: seeds live in this browser', activeServerHash: f.serverHash, nextServerHash: f.next.serverHash, clientSeed: f.clientSeed, revealed: f.revealed, history: f.history }, null, 2);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'vaultrush-fair-history.json' });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    // ---- verifier
    const syncFields = () => {
      const g = $('#vg', el).value;
      $('#vcaseF', el).hidden = g !== 'cases';
      $('#vbatF', el).hidden = g !== 'battles';
      $('#vminesF', el).hidden = g !== 'mines';
      $('#vplinkoF', el).hidden = g !== 'plinko';
    };
    $('#vg', el).onchange = syncFields; syncFields();

    $('#verify', el).onclick = async () => {
      const s = $('#vs', el).value.trim(), c = $('#vc', el).value.trim(), n = +$('#vn', el).value;
      if (!s) return toast('Paste a revealed server seed', 'error');
      const game = $('#vg', el).value;
      const hash = await sha256(s);
      const pair = revealed.find(r => r.serverHash === hash);
      const hashMsg = pair
        ? `<span class="pf-ok">✓ This seed hashes to a value we committed to you before play (nonces 0–${Math.max(0, pair.nonces - 1)}).</span>`
        : hash === f.serverHash ? '<span class="pf-bad">✗ That is your ACTIVE seed hash, not a seed. Rotate first to reveal it.</span>'
        : '<span class="pf-bad">✗ This seed does not match any hash committed to you in this browser. Results from it prove nothing about your bets.</span>';
      let out;
      const one = async () => (await floatsFor(s, c, n, 1))[0];
      if (game === 'crash') out = `Crash point: <b>${fmt(crashPoint(await one()))}×</b>`;
      else if (game === 'double') { const r = doubleRoll(await one()); out = `Tile <b>${r}</b> (${doubleColor(r)})`; }
      else if (game === 'cases') { const cs = CASE[$('#vcase', el).value]; const t = ticketOf(await one()); const it = entryForTicket(cs, t).item; out = `Ticket <b>#${t}</b> → <b>${esc(it.weapon)} | ${esc(it.skin)}</b> (${fmt(it.value)})`; }
      else if (game === 'battles') {
        const P = Math.min(6, Math.max(2, +$('#vplayers', el).value || 2)), ids = $('#vcases', el).value.split(',').map(x => x.trim()).filter(Boolean);
        if (ids.some(id => !CASE[id])) return toast('Unknown case id in the list', 'error');
        const fl = await floatsFor(s, c, n, P * ids.length + 1);
        const rows = Array.from({ length: P }, (_, p) => ids.map((id, r) => { const t = ticketOf(fl[r * P + p]); const it = entryForTicket(CASE[id], t).item; return `#${t} ${esc(it.skin)} (${fmt(it.value)})`; }));
        out = rows.map((r, p) => `Slot ${p + 1}: ${r.join(' · ')}`).join('<br>') + `<br>Tie-break / jackpot roll: <b>${fl[fl.length - 1].toFixed(6)}</b>`;
      }
      else if (game === 'mines') { const N = +$('#vgrid', el).value; const m = Math.min(N - 1, Math.max(1, +$('#vmines', el).value)); out = `Mines on tiles: <b>${minePositions(await floatsFor(s, c, n, N - 1), m, N).map(x => x + 1).sort((a, b) => a - b).join(', ')}</b>`; }
      else if (game === 'plinko') { const rows = +$('#vrows', el).value, risk = $('#vrisk', el).value; const path = plinkoPath(await floatsFor(s, c, n, rows), rows); const b = path.reduce((a, x) => a + x, 0); out = `Path ${path.map(x => (x ? 'R' : 'L')).join('')} → bucket <b>${b}</b> = <b>${fmt(plinkoTable(rows, risk)[b])}×</b>`; }
      else if (game === 'coinflip') { const r = await one(); out = `Coin: <b>${r < 0.5 ? '⚡ Bolt' : '★ Star'}</b> (roll ${r.toFixed(6)}, below 0.5 = Bolt)`; }
      else out = `Roll: <b>${((await one()) * 100).toFixed(4)}</b> (under wins below the chance %, over wins above 100 − chance)`;
      $('#vout', el).innerHTML = `<div>${hashMsg}</div><div class="small muted">SHA-256 of that seed</div><div class="mono">${hash}</div><div>${out}</div>`;
    };

    // ---- house edge + randomness
    $('#rtpRun', el).onclick = async () => {
      const btn = $('#rtpRun', el), bar = $('#rtpBar', el);
      btn.disabled = true; bar.hidden = false;
      const n = +$('#rtpN', el).value;
      rtpRows = await rtpTest(n, p => { bar.firstElementChild.style.width = `${(p * 100).toFixed(1)}%`; });
      uni = await uniformityTest(20000);
      bar.hidden = true; btn.disabled = false;
      $('#rtpOut', el).innerHTML = rtpTable(rtpRows);
      $('#uniOut', el).innerHTML = uniView(uni);
    };

    // ---- re-check every stored bet against the revealed seeds
    const checked = await verifyAll(f.history, revealed);
    if (!el.isConnected) return;
    const body = $('#histBody', el);
    if (body && f.history.length) {
      const label = { ok: '<span class="pf-ok">✓ verified</span>', bad: '<span class="pf-bad">✗ mismatch</span>', seed: '<span class="pf-bad">✗ seed ≠ hash</span>', active: '<span class="muted">hidden until rotate</span>', old: '<span class="muted">older bet</span>' };
      body.innerHTML = checked.map(({ b, status, text }) => `<tr><td class="mono">${b.id}</td><td>${b.game}</td><td>${b.nonce}</td><td class="mono small">${b.serverHash.slice(0, 16)}…${b.serverHash === f.serverHash ? ' <span class="tag">active</span>' : ''}</td><td class="small" title="${esc(text || '')}">${esc(status === 'active' ? '' : b.result || '')}</td><td class="small">${label[status]}</td></tr>`).join('');
      const done = checked.filter(x => ['ok', 'bad', 'seed'].includes(x.status)), ok = done.filter(x => x.status === 'ok').length, old = checked.filter(x => x.status === 'old').length;
      $('#histSum', el).innerHTML = done.length ? `${ok} of ${done.length} revealed bets recomputed correctly${old ? ` · ${old} older bets pre-date verification` : ''}` : old ? `${old} older bets pre-date verification. Rotate after your next bets to check them` : 'Rotate the server seed to unlock verification of your past bets';
    }
  };

  draw();
}

function rtpTable(rows) {
  const ok = rows.filter(r => r.pass).length;
  return `<div class="pf-sum ${ok === rows.length ? 'good' : 'warn'}">${ok} of ${rows.length} checks within tolerance</div>
  <div class="table-wrap"><table class="bets pf-rtp"><thead><tr><th>Mode</th><th>Theoretical RTP</th><th>Measured RTP</th><th>House edge</th><th>Rounds</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.name)}</b><div class="small muted">${esc(r.rule)}</div></td><td>${pct(r.theory)}</td><td>${r.exact ? `${pct(r.sim)} <span class="muted small">exact (cases ${pct(r.min)}–${pct(r.max)})</span>` : `${pct(r.sim)} <span class="muted small">±${(r.se * 100).toFixed(2)}%</span>`}</td><td>${edge(r.exact ? r.sim : r.theory)}</td><td>${r.exact ? 'exact' : r.rounds.toLocaleString('en-US')}</td><td>${r.pass ? '<span class="pf-ok">✓</span>' : '<span class="pf-bad">✗</span>'}</td></tr>`).join('')}</tbody></table></div>
  <p class="muted small">Single long-shot items (e.g. a 3,200 coin drop at 0.008%) dominate the variance of individual cases, so those are checked exactly from the ticket table instead of by simulation.</p>`;
}

function uniView(u) {
  const max = Math.max(...u.bins);
  return `<div class="pf-hist">${u.bins.map(b => `<i style="height:${(b / max) * 100}%" title="${b}"></i>`).join('')}</div>
  <div class="small ${u.pass ? 'pf-ok' : 'pf-bad'}">${u.pass ? '✓' : '✗'} ${u.n.toLocaleString('en-US')} rolls · mean ${u.mean.toFixed(4)} (ideal 0.5000) · χ² = ${u.chi.toFixed(1)} (19 degrees of freedom, fail above ${u.crit})</div>`;
}
