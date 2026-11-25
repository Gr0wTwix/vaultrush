// The loading screen. It is drawn by index.html itself (markup and styles there), so it shows before any of the site's files arrive.
// boot() in app.ts calls hideSplash() once the first page is drawn. The screen stays at least SPLASH_MIN_MS after the page started
// loading, so a fast load shows the animation instead of a flash, then fades out and is removed.

export const SPLASH_MIN_MS = 900;
export const SPLASH_FADE_MS = 450;

/** Fades the loading screen out and removes it. Safe to call more than once; resolves when it is gone. */
export function hideSplash(sinceStart: number = performance.now()): Promise<void> {
  const el = document.getElementById('splash');
  if (!el || el.classList.contains('out')) return Promise.resolve();
  const wait = Math.max(0, SPLASH_MIN_MS - sinceStart);
  return new Promise(done => {
    setTimeout(() => {
      el.classList.add('out');
      document.querySelector('.app')?.removeAttribute('aria-busy');
      setTimeout(() => { el.remove(); done(); }, SPLASH_FADE_MS);
    }, wait);
  });
}
