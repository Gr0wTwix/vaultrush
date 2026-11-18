// Public responsible-play policy page (linked from the footer and the 18+ gate).
import { HELP_RESOURCES, COOLING_MS } from '../rg.js';
import { TIER_MAX_BET } from '../kyc.js';
import { REPORTING_THRESHOLD } from '../aml.js';
import { $, esc, icon } from '../ui.js';
import { openAccount } from '../account.js';

export function render(el: HTMLElement): void {
  const tools: [string, string, string][] = [
    ['Deposit-style limits', 'Daily, weekly and monthly loss limits, a daily wager limit and a maximum single bet. Tightening is instant; loosening or removing waits 24 hours and can be cancelled.', 'responsible'],
    ['Time limits and reality checks', 'A visible session clock, a daily play-time limit and a reminder every 15, 30 or 60 minutes showing your time and your net result.', 'responsible'],
    ['Cool-off and self-exclusion', `Short breaks (24 hours to 30 days) and self-exclusion from 1 hour to 30 days. Neither can be shortened once started.`, 'responsible'],
    ['Self-assessment', 'The nine-question Problem Gambling Severity Index, scored on your device, with guidance and links to free support.', 'responsible'],
    ['Age and identity checks', `Everyone confirms they are 18+. Bets above ${TIER_MAX_BET[0]} coins need email and date-of-birth checks, and above ${TIER_MAX_BET[1]} full identity verification. Payouts of ${REPORTING_THRESHOLD}+ always need full verification.`, 'kyc'],
  ];
  el.innerHTML = `
    <div class="page-head"><h1>${icon('fair')} Responsible play</h1><p class="muted">Vaultrush is a play-money demo for adults (18+). These are the protections built into it.</p></div>
    <div class="rgp-grid">${tools.map(([t, d, tab]) => `<div class="panel rgp-card"><h3>${esc(t)}</h3><p>${esc(d)}</p><button class="btn btn-ghost" data-tab="${tab}">Open</button></div>`).join('')}</div>
    <div class="panel rgp-block"><h2>How the rules work</h2>
      <ul class="rgp-list">
        <li><b>Limits you tighten take effect immediately.</b> Raising or removing a limit waits ${COOLING_MS / 3_600_000} hours, so a bad moment cannot undo a good decision.</li>
        <li><b>Loss limits count settled bets,</b> so winnings offset losses within the period. A bet that could take you past the limit is refused before it is placed.</li>
        <li><b>Every bet passes the same gate:</b> age confirmation, self-exclusion, cool-off, compliance holds, your limits and your verification level.</li>
        <li><b>Nothing here is a real-money service.</b> Coins cannot be bought or withdrawn. The payout simulator only demonstrates how checks would behave.</li>
      </ul></div>
    <div class="panel rgp-block"><h2>If gambling stops being fun</h2>
      <p class="muted">Set a limit or start a break from your account, and consider talking to someone. Free and confidential support:</p>
      <ul class="rg-help">${HELP_RESOURCES.map(h => `<li><a href="${h.url}" target="_blank" rel="noopener noreferrer">${esc(h.name)}</a></li>`).join('')}</ul></div>
    <div class="panel rgp-block"><h2>Fair games</h2><p class="muted">Every result is generated from a committed seed and can be re-checked on the <a href="#/fair">Fairness page</a>. The generator is tested continuously in the <a href="#/rng">RNG lab</a>.</p></div>`;
  el.querySelectorAll('[data-tab]').forEach(b => (b as HTMLElement).onclick = () => openAccount((b as HTMLElement).dataset.tab as string));
  void $;
}
