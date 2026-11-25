// Item pictures: the item's own image (Valve's community CDN, see src/data.ts). While it loads, or if it cannot be fetched, a plain grey tile is shown instead.

/** A small grey "no picture" tile, used when an image is missing or fails to load. */
export const NO_PICTURE = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 256 192%27%3E%3Crect x=%2796%27 y=%2760%27 width=%2764%27 height=%2672%27 rx=%278%27 fill=%27%23808aa0%27 opacity=%27.25%27/%3E%3C/svg%3E";

/**
 * The picture of an item. `eager` is for pictures inside a moving reel: they must be fetched now, not when they scroll near the screen (a lazy
 * picture inside a strip that is clipped by its box would still be blank when the strip reaches it).
 */
/** One listener replaces any picture that fails to load: `data-fallback="grey"` shows the grey tile, `data-fallback="remove"` removes the picture.
 *  (Inline onerror attributes would need 'unsafe-inline' scripts in the Content Security Policy; this keeps the policy strict.) */
export function installImageFallback(doc: Document = document): void {
  doc.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const fb = img.dataset['fallback'];
    if (fb === 'remove') img.remove();
    else if (fb === 'grey') { delete img.dataset['fallback']; img.src = NO_PICTURE; }
  }, true);
}
if (typeof document !== 'undefined') installImageFallback();

export function itemArtSvg(item, eager = false): string {
  const src = item.img || NO_PICTURE;
  return `<img class="item-art" src="${src}" alt="" ${eager ? 'loading="eager"' : 'loading="lazy"'} decoding="async" draggable="false" referrerpolicy="no-referrer" data-fallback="grey">`;
}
