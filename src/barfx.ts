// The balance and inventory chip in the top bar. It glows green only when something was ADDED: coins (a sale, a win, a reward) or an item. Nothing else
// makes it glow: not a bet, not a setting, not a page that merely saved the player's state. Loading an account (signing in, the first sync with the server)
// is not a gain either, so it is quiet. One animation length for everything, so it never depends on the animation speed of a game.
import { emit, isServerWallet, level, on, state } from './state.js';
import { fmt } from './ui.js';

/** Whether a change deserves the green glow. Only an increase does, and only when it is not just an account being loaded. */
export const bumps = (prev: { bal: number; inv: number }, next: { bal: number; inv: number }, loud: boolean): { balance: boolean; inventory: boolean } =>
  ({ balance: loud && next.bal > prev.bal + 0.004, inventory: loud && next.inv > prev.inv });

const flash = (node: Element | null, cls: string): void => { if (!node) return; node.classList.remove(cls); void (node as HTMLElement).offsetWidth; node.classList.add(cls); };
export const QUIET_MS = 2500, COUNT_MS = 450;

/**
 * Keep the chip in step with the state. invCount is how many items the bar shows (an item still being revealed by its animation is not counted yet, so the
 * inventory glow arrives when the reel stops, not when the server answers).
 */
export function initBarFx(root: ParentNode, invCount: () => number): () => void {
  let shown = state.balance, shownInv = invCount(), shownLevel = level(), quietUntil = 0, animId = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const quiet = (): void => { quietUntil = Date.now() + QUIET_MS; };

  const apply = (): void => {
    const el = root.querySelector('#bal') as HTMLElement | null, chip = root.querySelector('#invCount') as HTMLElement | null;
    if (!el) return;
    const to = state.balance, from = shown, inv = invCount(), loud = Date.now() >= quietUntil;
    const glow = bumps({ bal: from, inv: shownInv }, { bal: to, inv }, loud);
    if (to !== from) {
      shown = to;
      if (glow.balance) flash(el.parentElement, 'bump-up');
      const id = ++animId, t0 = performance.now();
      // No count-up animation for people who asked for less motion or turned visual effects off.
      const calm = !state.ui.fx || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (calm) el.textContent = fmt(to);
      else {
        const step = (t: number): void => {
          if (id !== animId) return;                                       // a newer change took over: never two counters fighting over the number
          const k = Math.min(1, (t - t0) / COUNT_MS);
          el.textContent = fmt(from + (to - from) * (1 - (1 - k) ** 3));
          if (k < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
        };
        requestAnimationFrame(step);
      }
    }
    // The level badge on the avatar always shows the account's real level (XP comes from the server now, so nothing else tells the bar it changed).
    const lvl = level();
    if (lvl !== shownLevel) {
      const was = shownLevel; shownLevel = lvl;
      const badge = root.querySelector('#meLvl'); if (badge) badge.textContent = String(lvl);
      if (loud && lvl > was && isServerWallet()) emit('levelup', lvl);          // (without the server wallet, debit() announces level-ups itself)
    }
    if (inv !== shownInv) {
      shownInv = inv;
      const b = chip?.querySelector('b'); if (b) b.textContent = String(inv);
      if (glow.inventory) flash(chip, 'inv-bump');
    }
  };

  // The decision is made one tick after the change, so that "the account was just loaded" (an 'auth' message right behind the state change) can silence it.
  const off = [on('state', () => { clearTimeout(timer); timer = setTimeout(apply, 0); }), on('auth', quiet), on('wallet:quiet', quiet)];
  return () => { clearTimeout(timer); off.forEach(f => f()); };
}
