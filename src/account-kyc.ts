// Account window > Verification: KYC tiers (sandbox), AML monitoring and the payout simulator.
import { state, save, isServerWallet } from './state.js';
import {
  SCENARIOS, TIER_MAX_BET, TIER_NAMES, declareSourceOfFunds, requestEmailCode, resolveReview, submitDob, submitDocument, verifyEmailCode, type ScenarioId,
} from './kyc.js';
import { REPORTING_THRESHOLD, SOF_THRESHOLD, accountRisk, applyPayout, bonusCoins, caseReport, clearAlert, scanAccount, winZScore } from './aml.js';
import type { PaneCtx } from './account-rg.js';
import { $, $$, esc, fmt, icon, money, toast } from './ui.js';
import { sfx } from './sfx.js';
import { activeAccount } from './accounts.js';
import { renderServerVerification } from './verification-server.js';

const when = (t: number): string => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const step = (done: boolean, title: string, body: string): string =>
  `<div class="kyc-step ${done ? 'done' : ''}"><span class="kyc-dot">${done ? '✓' : ''}</span><div class="kyc-body"><b>${title}</b>${body}</div></div>`;

let demoCode = '';          // the sandbox "inbox": shown on screen because no email is actually sent

export function renderVerification(pane: HTMLElement, ctx: PaneCtx): void {
  const k = state.kyc, a = state.aml, risk = accountRisk(state), z = winZScore(state);
  const open = a.alerts.filter(x => x.status === 'open');
  const approvedPaid = a.payouts.filter(p => p.decision === 'approved').reduce((s, p) => s + p.amount, 0);
  const needSof = approvedPaid >= SOF_THRESHOLD * 0.5 || k.sofDeclared;
  const docState = k.docStatus === 'approved' ? 'Approved' : k.docStatus === 'review' ? 'In manual review' : k.docStatus === 'hold' ? 'Compliance hold' : k.docStatus === 'rejected' ? 'Rejected' : 'Not submitted';

  pane.innerHTML = `
    <h2 class="ac-h">Verification</h2>
    <p class="ac-sub">Know-your-customer and anti-money-laundering controls, running in <b>sandbox mode</b>: it behaves like a real provider integration, but no documents are collected, nothing is sent anywhere, and no money moves.</p>
    <div id="kServer"></div>

    <div class="ac-card kyc-tier"><div><span class="muted small">Your level</span><b class="kyc-tier-n">Level ${k.tier}</b><span>${TIER_NAMES[k.tier]}</span></div>
      <div class="kyc-lim"><span class="muted small">Highest single bet</span><b>${fmt(TIER_MAX_BET[k.tier])}</b></div>
      <div class="kyc-lim"><span class="muted small">Account risk</span><b class="risk-${risk.band}">${risk.band}</b></div></div>

    <div class="ac-card"><h3>Steps</h3>
      ${step(k.emailVerifiedAt > 0, 'Email', `<p class="ac-note">${k.emailVerifiedAt ? `Verified: ${esc(k.email)}` : 'We send a 6-digit code. In the sandbox it appears below instead of an inbox.'}</p>
        ${k.emailVerifiedAt ? '' : `<div class="ac-inline"><input id="kEmail" type="email" placeholder="you@example.com" value="${esc(k.email || activeAccount()?.email || '')}"><button class="btn btn-ghost" id="kSend">Send code</button></div>
        ${demoCode ? `<div class="kyc-inbox">Sandbox inbox: your code is <b>${demoCode}</b></div><div class="ac-inline"><input id="kCode" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button class="btn btn-primary" id="kVerify">Verify</button></div>` : ''}`}`)}
      ${step(!!k.dob, 'Date of birth', `<p class="ac-note">${k.dob ? `Accepted. Only adults (18+) can play.` : 'Players must be 18 or older.'}</p>
        ${k.dob ? '' : '<div class="ac-inline"><input id="kDob" type="date"><button class="btn btn-ghost" id="kDobSave">Save</button></div>'}`)}
      ${step(k.docStatus === 'approved', 'Identity document and liveness', `<p class="ac-note">Status: <b>${docState}</b>${k.docReason ? `. ${esc(k.docReason)}` : ''}</p>
        ${k.tier < 1 ? '<p class="ac-note">Finish the steps above first.</p>' : k.docStatus === 'approved' ? '' : k.docStatus === 'hold' ? '<p class="ac-note">This case is held for compliance review and cannot be released here.</p>' : `
        <div class="kyc-sandbox"><b>Sandbox:</b> pick the outcome the screening provider should return. Do not enter real personal data.</div>
        <div class="ac-inline"><input id="kName" placeholder="Full name (first and last)" value="${esc(k.fullName)}"></div>
        <div class="ac-inline"><select id="kScenario" aria-label="Sandbox scenario">${SCENARIOS.map(s => `<option value="${s.id}" ${k.sandbox === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select><button class="btn btn-primary" id="kDoc">Run check</button></div>
        <p class="ac-note">Names on the (mock) sanctions and PEP lists are held automatically, for example "Test Sanctioned".</p>
        ${k.docStatus === 'review' ? '<div class="ac-inline"><span class="muted small">Sandbox reviewer:</span><button class="btn btn-ghost btn-sm" id="kApprove">Approve</button><button class="btn btn-ghost btn-sm" id="kReject">Reject</button></div>' : ''}`}`)}
      ${needSof ? step(k.sofDeclared, 'Source of funds', `<p class="ac-note">Needed once total payouts reach ${SOF_THRESHOLD}.${k.sofDeclared ? ' Declaration recorded.' : ''}</p>${k.sofDeclared ? '' : '<div class="ac-inline"><input id="kSof" placeholder="Where does your money come from?"><button class="btn btn-ghost" id="kSofSave">Save</button></div>'}`) : ''}
    </div>

    <div class="ac-card"><h3>Payout simulator</h3>
      <p class="ac-note">Try a cash-out request to see the AML rules decide. Coins leave your balance only if approved, and <b>no real money is involved</b>. Payouts of ${REPORTING_THRESHOLD}+ need Level 2; bonus coins (${fmt(bonusCoins(state))} so far) must be wagered once first.</p>
      <div class="ac-inline"><input id="pAmt" type="number" min="1" step="1" placeholder="Amount in coins"><button class="btn btn-ghost" id="pGo">Simulate payout</button></div><div id="pRes"></div>
    </div>

    <div class="ac-card"><h3>Monitoring</h3>
      <div class="ac-stats three"><div class="ac-stat"><b class="risk-${risk.band}">${risk.score} / 100</b><span>Risk score</span></div><div class="ac-stat"><b>${open.length}</b><span>Open alerts</span></div><div class="ac-stat"><b>${z.n >= 30 ? z.z.toFixed(1) : 'n/a'}</b><span>Win-rate z-score${z.n < 30 ? ' (needs 30 bets)' : ''}</span></div></div>
      ${a.alerts.length ? `<div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Rule</th><th>Severity</th><th>Detail</th><th class="r"></th></tr></thead><tbody>${a.alerts.slice(0, 10).map(x => `<tr><td>${esc(x.rule)}</td><td><span class="sev sev-${x.severity}">${x.severity}</span></td><td class="wrap">${esc(x.text)}<small class="ac-subtle">${when(x.at)}</small></td><td class="r">${x.status === 'open' ? `<button class="btn btn-ghost btn-sm" data-clear="${x.id}">Clear</button>` : '<span class="muted small">cleared</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="ac-empty">No alerts. Request a payout or run a scan to see monitoring work.</div>'}
      <div class="ac-links"><button class="btn btn-ghost" id="mScan">Run monitoring scan</button><button class="btn btn-ghost" id="mReport">Download case report</button></div>
      ${a.payouts.length ? `<h3 class="ac-tier-h">Payout requests</h3><div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Amount</th><th>Decision</th><th>Reasons</th><th class="r">Time</th></tr></thead><tbody>${a.payouts.slice(0, 8).map(p => `<tr><td>${money(p.amount)}</td><td><span class="sev sev-${p.decision === 'approved' ? 'ok' : p.decision === 'review' ? 'medium' : 'high'}">${p.decision}</span></td><td class="wrap">${p.reasons.length ? p.reasons.map(esc).join('<br>') : '<span class="muted">No findings</span>'}</td><td class="r muted">${when(p.at)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>
    ${k.log.length ? `<div class="ac-card"><h3>Verification log</h3><ul class="rg-log">${k.log.slice(0, 8).map(l => `<li><span class="muted">${when(l.at)}</span> ${esc(l.text)}</li>`).join('')}</ul></div>` : ''}`;

  const fail = (msg: string): void => { toast(msg, 'error'); };
  if (isServerWallet()) void renderServerVerification($('#kServer', pane));        // the level the server uses, asked of staff (0026)
  $('#kSend', pane)?.addEventListener('click', () => {
    const r = requestEmailCode(k, ($('#kEmail', pane) as HTMLInputElement).value);
    if (!r.ok) return fail(r.error ?? 'Could not send');
    demoCode = r.code ?? ''; save(); ctx.rerender();
  });
  $('#kVerify', pane)?.addEventListener('click', () => {
    const r = verifyEmailCode(k, ($('#kCode', pane) as HTMLInputElement).value);
    if (!r.ok) return fail(r.error ?? 'Could not verify');
    demoCode = ''; save(); sfx.win(); toast('Email verified', 'win'); ctx.rerender();
  });
  $('#kDobSave', pane)?.addEventListener('click', () => {
    const r = submitDob(k, ($('#kDob', pane) as HTMLInputElement).value);
    save(); if (!r.ok) return fail(r.error ?? 'Could not save'); sfx.click(); ctx.rerender();
  });
  $('#kDoc', pane)?.addEventListener('click', () => {
    const r = submitDocument(k, ($('#kName', pane) as HTMLInputElement).value, ($('#kScenario', pane) as HTMLSelectElement).value as ScenarioId);
    save(); if (!r.ok) return fail(r.error ?? 'Could not run the check'); sfx.click(); ctx.rerender();
  });
  $('#kApprove', pane)?.addEventListener('click', () => { resolveReview(k, true); save(); ctx.rerender(); });
  $('#kReject', pane)?.addEventListener('click', () => { resolveReview(k, false); save(); ctx.rerender(); });
  $('#kSofSave', pane)?.addEventListener('click', () => {
    const r = declareSourceOfFunds(k, ($('#kSof', pane) as HTMLInputElement).value);
    save(); if (!r.ok) return fail(r.error ?? 'Could not save'); ctx.rerender();
  });
  $('#pGo', pane).onclick = () => {
    const amount = Number(($('#pAmt', pane) as HTMLInputElement).value);
    const r = applyPayout(state, amount);
    save();
    const cls = r.decision === 'approved' ? 'ok' : r.decision === 'review' ? 'medium' : 'high';
    $('#pRes', pane).innerHTML = `<div class="ac-card"><h3><span class="sev sev-${cls}">${r.decision}</span> risk score ${r.score}</h3>${r.reasons.length ? `<ul class="rg-log">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="ac-note">No findings. The request passed every rule.</p>'}</div>`;
    if (r.decision === 'approved') sfx.win();
    setTimeout(ctx.rerender, 3500);
  };
  $$('[data-clear]', pane).forEach((b: HTMLElement) => b.onclick = () => { clearAlert(state, Number(b.dataset.clear)); save(); ctx.rerender(); });
  $('#mScan', pane).onclick = () => { const n = scanAccount(state).length; save(); toast(n ? `${n} new alert(s)` : 'Scan complete: nothing new'); ctx.rerender(); };
  $('#mReport', pane).onclick = () => {
    const blob = new Blob([JSON.stringify(caseReport(state), null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'vaultrush-case-report.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  };
  void icon;
}
