// A short tour shown on the first visit (idea from CSGOBig's "first time here?" tips). Shown once per browser; "Show the site tips" in the footer opens
// it again. It never appears on top of another window (the 18+ question, the log-in popup): then it waits for the next visit.
import { icon, modal } from './ui.js';

export const TIPS_KEY = 'vaultrush.tips.v1';
export const TIPS: [string, string, string][] = [
  ['bolt', 'Play money only', 'Coins have no cash value and can never be bought or withdrawn. Claim free coins every 10 minutes, and open the free crates on the Rewards page.'],
  ['cases', 'See the odds before you open', 'Every case lists each item\'s drop chance and ticket range. The Low, Medium or High risk label is the chance that one opening gives back at least the price.'],
  ['battles', 'Battles and Upgrade', 'Open cases against other players or bots in Battles; empty seats can be filled by bots, who play for the house. Upgrade trades a stake for a chance at a better item, up to 80%.'],
  ['fair', 'Every result can be checked', 'Results come from a secret seed whose fingerprint you see before you play. After you rotate it, the Fairness page re-calculates every bet.'],
  ['heart', 'Stay in control', 'Set loss, wager and time limits, take a cool-off or self-exclude under Account, Responsible Play. Free help is linked at the bottom of every page.'],
];

const seen = (): boolean => { try { return !!localStorage.getItem(TIPS_KEY); } catch { return true; } };     // storage blocked: never nag
const markSeen = (): void => { try { localStorage.setItem(TIPS_KEY, String(Date.now())); } catch { /* fine */ } };

/** Show the tips now, from the first one. */
export function showTips(): void {
  let i = 0;
  const m = modal('<div class="tips"></div>', { label: 'Site tips', onClose: markSeen });
  const box = m.el.querySelector('.tips') as HTMLElement;
  const draw = (): void => {
    const [ic, title, text] = TIPS[i] as [string, string, string];
    box.innerHTML = `<div class="tips-icon">${icon(ic)}</div><div class="muted small">Tip ${i + 1} of ${TIPS.length}</div><h2>${title}</h2><p>${text}</p>
      <div class="tips-dots" aria-hidden="true">${TIPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="row tips-nav"><button type="button" class="btn btn-ghost" data-t="skip">${i === TIPS.length - 1 ? 'Close' : 'Skip'}</button>
        ${i > 0 ? '<button type="button" class="btn btn-ghost" data-t="back">Back</button>' : ''}
        ${i < TIPS.length - 1 ? '<button type="button" class="btn btn-primary" data-t="next">Next</button>' : '<button type="button" class="btn btn-primary" data-t="done">Start playing</button>'}</div>`;
    (box.querySelector('[data-t="next"], [data-t="done"]') as HTMLElement | null)?.focus();
  };
  box.onclick = e => {
    const t = (e.target as Element).closest('[data-t]') as HTMLElement | null; if (!t) return;
    const a = t.dataset.t;
    if (a === 'next') { i = Math.min(TIPS.length - 1, i + 1); draw(); }
    else if (a === 'back') { i = Math.max(0, i - 1); draw(); }
    else m.close();
  };
  draw();
}

/** On the first visit, once nothing else is on screen. */
export function maybeShowTips(): void {
  if (seen()) return;
  if (document.querySelector('.rg-overlay, .modal-back')) return;          // the 18+ question or another window comes first; try again next visit
  showTips();
}

/** The footer link that opens the tips again. */
export function wireTipsLink(): void {
  document.addEventListener('click', e => { if ((e.target as Element).closest?.('#ftTips')) { e.preventDefault(); showTips(); } });
}
