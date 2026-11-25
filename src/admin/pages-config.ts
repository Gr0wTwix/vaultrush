// Step E part 3 of the admin plan (migration 0025): the Game settings page. Stake limits per game, the Crash and Double betting windows, lobby
// expiry and caps, house bots and their names, and the simulated activity. The house edge is shown for information only (it is part of what
// the fairness pages prove, so it is not a setting).
import type { GameSettings } from './api.js';
import { errorText } from './api.js';
import { $, $$, esc, reasonDialog, when } from './dom.js';
import type { Page } from './pages.js';

const NAMES: Record<string, string> = { cases: 'Cases', battles: 'Battles', upgrade: 'Upgrade', crash: 'Crash', double: 'Double', plinko: 'Plinko', mines: 'Mines', coinflip: 'Coinflip' };
const WHAT: Record<string, string> = { cases: 'one opening (price × number of cases)', battles: 'joining or creating a battle (its cost)', upgrade: 'the coins put into one upgrade', crash: 'one bet', double: 'one bet', plinko: 'one drop', mines: 'one game', coinflip: 'one flip' };
/** How each game keeps its edge (from the game code). For information. */
const EDGE: [string, string][] = [
  ['Cases', 'each case returns its own percentage of the price (90% for the generated cases; set per case on the Catalogue page, 70% to 98%)'],
  ['Crash', 'the crash point is 0.97 / (1 − random), so the edge is 3% (about 3% of rounds end at 1.00×)'], ['Double', '15 tiles; purple and gray pay 2×, green 14×, the bait tiles 7×: about 6.7% edge on every colour'],
  ['Upgrade', 'the chance is the stake divided by the target value, times 0.95 (at most 80%): 5% edge'], ['Plinko, Mines', 'every payout is the fair one times 0.97: 3% edge'],
  ['Coinflip, Battles', 'between players: no edge; a house bot plays for the house'],
];

const config: Page = {
  title: 'Game settings', perm: 'config.view',
  async render(el, c) {
    const s = await c.api.gameSettings(), canEdit = c.perms.includes('config.edit'), dis = canEdit ? '' : 'disabled';
    const games = s.games ?? Object.keys(s.limits);
    el.innerHTML = `<p class="muted">How the games run. The database enforces every value from the next request; the game site reads them when a page loads. Every change asks for a reason and is logged with the old and new values.${s.updated_by ? ` Last changed by ${esc(s.updated_by)}, ${esc(when(s.updated_at))}.` : ''}</p>
      <section class="block"><h2>Stakes per game</h2><p class="muted small">The smallest and largest stake for one action, on top of each player's own limits and the verification caps (10,000 / 25,000 / 50,000). At most 50,000.</p>
        <div class="tablewrap"><table class="grid"><thead><tr><th>Game</th><th>One action is</th><th>Smallest</th><th>Largest</th></tr></thead><tbody>${games.map(g => `<tr data-g="${esc(g)}"><td>${esc(NAMES[g] ?? g)}</td><td class="muted small">${esc(WHAT[g] ?? '')}</td>
          <td><input type="number" min="0.01" max="50000" step="0.01" value="${s.limits[g]?.min ?? 0.01}" data-min ${dis} style="width:8em" aria-label="${esc(NAMES[g] ?? g)} smallest stake"></td>
          <td><input type="number" min="0.01" max="50000" step="0.01" value="${s.limits[g]?.max ?? 50000}" data-max ${dis} style="width:8em" aria-label="${esc(NAMES[g] ?? g)} largest stake"></td></tr>`).join('')}</tbody></table></div></section>
      <section class="block"><h2>Rounds and lobbies</h2>
        <div class="row wrap"><label for="cCrash">Crash takes bets for (seconds)</label><input id="cCrash" type="number" min="5" max="20" value="${s.crash_bet_seconds}" ${dis} style="max-width:90px">
          <label for="cDouble">Double takes bets for (seconds)</label><input id="cDouble" type="number" min="8" max="30" value="${s.double_bet_seconds}" ${dis} style="max-width:90px"></div>
        <div class="row wrap"><label for="cLobby">A waiting lobby is cancelled and refunded after (minutes)</label><input id="cLobby" type="number" min="5" max="120" value="${s.lobby_minutes}" ${dis} style="max-width:90px"></div>
        <div class="row wrap"><label for="cBat">Open battles per player</label><input id="cBat" type="number" min="1" max="10" value="${s.battle_lobbies_max}" ${dis} style="max-width:80px">
          <label for="cFlip">Open coinflips per player</label><input id="cFlip" type="number" min="1" max="20" value="${s.flip_lobbies_max}" ${dis} style="max-width:80px"></div>
        <p class="muted small">The roll of Double (5.2 s) and the pause between rounds stay as they are: the game's animation is built around them.</p></section>
      <section class="block"><h2>House bots and simulated activity</h2>
        <div class="row wrap"><label class="chk"><input type="checkbox" id="cBotB" ${s.bots_battles ? 'checked' : ''} ${dis}> Bots can fill seats in live battles</label>
          <label class="chk"><input type="checkbox" id="cBotF" ${s.bots_coinflip ? 'checked' : ''} ${dis}> A bot can take the other side of a live coinflip</label></div>
        <label for="cNames">Bot names (separated by commas; 3 to 100; a new name may not be a real player's name)</label><textarea id="cNames" rows="3" ${dis}>${esc(s.bot_names.join(', '))}</textarea>
        <div class="row wrap"><label class="chk"><input type="checkbox" id="cSim" ${s.simulated_activity ? 'checked' : ''} ${dis}> Show simulated activity (made-up live drops and bets in the feed, so the site looks busy)</label></div>
        <p class="muted small">With bots off, players wait for real opponents. With simulated activity off, the feed shows only what real players do.</p></section>
      ${canEdit ? '<div class="row"><button class="btn primary" id="cSave">Save game settings…</button></div><p class="err" id="cErr" role="alert"></p>' : ''}
      <section class="block"><h2>House edge (information)</h2><p class="muted small">Not a setting: the edge is part of the game maths that the fairness pages let players check. Changing it is a code change with its own review.</p>
        <div class="tablewrap"><table class="grid"><tbody>${EDGE.map(([g, t]) => `<tr><td>${esc(g)}</td><td class="muted small">${esc(t)}</td></tr>`).join('')}</tbody></table></div></section>`;

    const read = (): GameSettings => ({
      crash_bet_seconds: Math.round(Number($<HTMLInputElement>('#cCrash', el).value)), double_bet_seconds: Math.round(Number($<HTMLInputElement>('#cDouble', el).value)),
      lobby_minutes: Math.round(Number($<HTMLInputElement>('#cLobby', el).value)), battle_lobbies_max: Math.round(Number($<HTMLInputElement>('#cBat', el).value)),
      flip_lobbies_max: Math.round(Number($<HTMLInputElement>('#cFlip', el).value)), bots_battles: $<HTMLInputElement>('#cBotB', el).checked, bots_coinflip: $<HTMLInputElement>('#cBotF', el).checked,
      simulated_activity: $<HTMLInputElement>('#cSim', el).checked, bot_names: $<HTMLTextAreaElement>('#cNames', el).value.split(',').map(x => x.trim()).filter(Boolean),
      limits: Object.fromEntries($$('tr[data-g]', el).map(tr => [tr.dataset['g'] as string, { min: Number($<HTMLInputElement>('[data-min]', tr).value), max: Number($<HTMLInputElement>('[data-max]', tr).value) }])),
    });
    const problems = (n: GameSettings): string[] => {
      const out: string[] = [];
      if (!(n.crash_bet_seconds >= 5 && n.crash_bet_seconds <= 20)) out.push('Crash: 5 to 20 seconds.');
      if (!(n.double_bet_seconds >= 8 && n.double_bet_seconds <= 30)) out.push('Double: 8 to 30 seconds.');
      if (!(n.lobby_minutes >= 5 && n.lobby_minutes <= 120)) out.push('Lobbies: 5 to 120 minutes.');
      if (!(n.battle_lobbies_max >= 1 && n.battle_lobbies_max <= 10) || !(n.flip_lobbies_max >= 1 && n.flip_lobbies_max <= 20)) out.push('Open lobbies: 1 to 10 battles, 1 to 20 coinflips.');
      if (n.bot_names.length < 3 || n.bot_names.length > 100 || n.bot_names.some(x => !/^[A-Za-z0-9_&-]{2,20}$/.test(x))) out.push(errorText('invalid_bot_names'));
      for (const [g, l] of Object.entries(n.limits)) if (!(l.min >= 0.01 && l.max <= 50000 && l.max >= l.min)) out.push(`${NAMES[g] ?? g}: the smallest stake must be at least 0.01 and not above the largest (at most 50,000).`);
      return out;
    };
    const check = (): void => { const p = problems(read()), e = $('#cErr', el), b = $<HTMLButtonElement>('#cSave', el); if (e) e.innerHTML = p.map(esc).join('<br>'); if (b) b.disabled = p.length > 0; };
    $$('input, textarea', el).forEach(i => i.addEventListener('input', check));
    $$('input[type=checkbox]', el).forEach(i => i.addEventListener('change', check));
    $('#cSave', el)?.addEventListener('click', async () => {
      const n = read(); if (problems(n).length) return;
      const changed = [n.bots_battles !== s.bots_battles ? `battle bots ${n.bots_battles ? 'on' : 'off'}` : '', n.bots_coinflip !== s.bots_coinflip ? `coinflip bot ${n.bots_coinflip ? 'on' : 'off'}` : '',
        n.simulated_activity !== s.simulated_activity ? `simulated activity ${n.simulated_activity ? 'on' : 'off'}` : ''].filter(Boolean).join(', ');
      const reason = await reasonDialog('Save the game settings?', `The database uses them from the next request${changed ? `; ${changed}` : ''}.`, 'Save');
      if (!reason) return;
      try { await c.api.saveGameSettings(n, reason); c.toast('Saved', 'ok'); c.reload(); } catch (e) { c.toast(errorText(e), 'error'); }
    });
  },
};

export const CONFIG_PAGES: Record<string, Page> = { config };
