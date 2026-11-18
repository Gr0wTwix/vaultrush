// RNG lab page: statistical battery on the live generator, health monitor, nonce audit and a downloadable self-assessed report.
import { getFair } from '../fair.js';
import { rngHealth, type TestResult } from '../rng.js';
import { DISCLAIMER, rngReport, type RngReport } from '../rnglab.js';
import { $, esc, icon, toast } from '../ui.js';

const row = (t: TestResult): string =>
  `<tr class="${t.pass ? '' : 'bad'}"><td>${esc(t.name)}${t.note ? `<small class="ac-subtle">${esc(t.note)}</small>` : ''}</td><td>${Number.isFinite(t.stat) ? t.stat.toPrecision(4) : '-'}</td><td>${t.p.toFixed(4)}</td><td><span class="sev sev-${t.pass ? 'ok' : 'high'}">${t.pass ? 'pass' : 'fail'}</span></td></tr>`;
const table = (title: string, rows: TestResult[]): string =>
  `<h3 class="ac-tier-h">${title}</h3><div class="table-wrap"><table class="bets ac-table"><thead><tr><th>Test</th><th>Statistic</th><th>p-value</th><th>Result</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;

export function render(el: HTMLElement): () => void {
  let alive = true, report: RngReport | null = null;
  const facts: [string, string][] = [
    ['Generator', 'HMAC-SHA256 keyed with a 256-bit server seed, over "clientSeed:nonce:round". Seeds come from the platform CSPRNG (crypto.getRandomValues).'],
    ['Output', '8 numbers per HMAC round, 32 bits each, scaled to [0, 1) by division by 2^32. Results are mapped with floor(f x N); the bias of that mapping is below N / 2^32, under 1 in 250 million for every game.'],
    ['Commitment', 'The hash of the next server seed is shown before it is used. Rotating a seed reveals the old one, and the Fairness page recomputes every bet made with it.'],
    ['Discipline', 'One nonce per bet, never reused, never skipped (audited below). No re-seeding inside a bet.'],
    ['Monitoring', 'Every number the live generator produces feeds the SP 800-90B repetition-count and adaptive-proportion health tests.'],
  ];
  const draw = (): void => {
    const h = rngHealth, history = getFair()?.history ?? [];
    el.innerHTML = `
      <div class="page-head"><h1>${icon('fair')} RNG lab</h1><p class="muted">Statistical tests on the generator that powers every game. Self-assessment tooling: it shows how the generator behaves, it is not a certificate.</p></div>
      <div class="panel"><div class="panel-head"><h2>Design</h2></div><ul class="rgp-list">${facts.map(([k, v]) => `<li><b>${esc(k)}.</b> ${esc(v)}</li>`).join('')}</ul></div>
      <div class="panel"><div class="panel-head"><h2>Live health monitor</h2><span class="sev sev-${h.ok ? 'ok' : 'high'}">${h.ok ? 'healthy' : 'alarm'}</span></div>
        <p class="muted small">${h.samples.toLocaleString('en-US')} numbers observed this session. Cut-offs: repetition count ${h.rctCutoff}, adaptive proportion ${h.aptCutoff} of ${h.windowSize} (false-alarm rate 2<sup>-20</sup>).${h.ok ? '' : ` Alarms: ${h.failures.map(esc).join('; ')}`}</p></div>
      <div class="panel"><div class="panel-head"><h2>Battery</h2><button class="btn btn-primary" id="rngRun">${report ? 'Run again' : 'Run the battery'}</button></div>
        <p class="muted small">Generates 30,000 numbers (960,000 bits) from the real generator on a throw-away seed, then runs NIST SP 800-22 style tests, FIPS 140-2, a Kolmogorov-Smirnov test, and checks each game's outcome mapping. A healthy generator still fails one test in roughly 40 runs at this significance level (alpha = 0.001); rerun before drawing conclusions.</p>
        <div id="rngProg"></div><div id="rngOut">${report ? out(report) : ''}</div></div>
      <div class="panel"><div class="panel-head"><h2>Nonce audit</h2></div>${(() => { const a = report?.nonces; return a ? `<p class="muted small">${a.seeds} seed(s) in your bet history. ${a.ok ? 'Every nonce is used exactly once and in order.' : esc(a.problems.join(' '))}</p>` : '<p class="muted small">Runs with the battery over your own bet history.</p>'; })()}<p class="muted small">${history.length} bets recorded.</p></div>
      <div class="panel"><div class="panel-head"><h2>Towards certification</h2></div><p class="muted small">${esc(DISCLAIMER)}</p>
        <ul class="rgp-list"><li>Submit the RNG design, source code and this test evidence to an accredited laboratory for review against the regulator's technical standard (for example GLI-19 for interactive gaming systems).</li><li>Certify the <b>production</b> generator: seeds and rolls must live on the server, with the seed store protected and access logged.</li><li>Keep continuous monitoring and nonce auditing running, and re-certify after any change to the generator or the game mappings.</li></ul></div>`;
    $('#rngRun', el).onclick = run;
    $('#rngDl', el)?.addEventListener('click', () => {
      if (!report) return;
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'vaultrush-rng-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  };
  const out = (r: RngReport): string => `
    <div class="rng-verdict ${r.verdict}"><b>${r.verdict === 'pass' ? 'All tests passed' : 'Attention: some tests failed'}</b> <span>${r.passed} of ${r.total} checks · ${r.floats.toLocaleString('en-US')} numbers · digest ${r.digest.slice(0, 16)}…</span><button class="btn btn-ghost btn-sm" id="rngDl">Download report</button></div>
    ${table('Bit and float tests (game generator)', r.tests)}${table('Game outcome tests', r.outcomes)}
    <h3 class="ac-tier-h">FIPS 140-2 (20,000-bit sample)</h3><div class="table-wrap"><table class="bets ac-table"><tbody>${r.fips.checks.map(c => `<tr><td>${esc(c.name)}</td><td>${c.value}</td><td><span class="sev sev-${c.pass ? 'ok' : 'high'}">${c.pass ? 'pass' : 'fail'}</span></td></tr>`).join('')}</tbody></table></div>
    ${table('Reference: platform CSPRNG with the same tests', r.reference)}`;
  async function run(): Promise<void> {
    const btn = $('#rngRun', el) as HTMLButtonElement; btn.disabled = true; btn.textContent = 'Running…';
    $('#rngProg', el).innerHTML = '<div class="rg-use"><i style="width:100%;animation:pulseBar 1.2s infinite"></i></div>';
    try { report = await rngReport({ floats: 30000, history: getFair()?.history ?? [] }); }
    catch (e) { toast(`RNG lab failed: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
    if (alive) draw();
  }
  draw();
  return () => { alive = false; };
}
