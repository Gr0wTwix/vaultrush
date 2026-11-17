// Case contents preview: click the eye on a case card.
import { CASE } from './data.js';
import { $, esc, money, fmt, itemCard, caseArt, modal } from './ui.js';

export const EYE = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
export const eyeBtn = id => `<button class="eye" data-preview="${id}" aria-label="Preview case contents" title="Preview contents">${EYE}</button>`;

export function previewCase(id) {
  const c = CASE[id]; if (!c) return;
  const m = modal(`
    <div class="pv-head" style="--hue:${c.hue}">
      <div class="pv-art">${caseArt(c)}</div>
      <div><h2>${esc(c.name)}</h2><div class="pv-price">${money(c.price)} <span class="muted small">· ${c.entries.length} items · top drop ${money(c.entries[0].item.value)}</span></div></div>
      <a class="btn btn-primary" href="#/case/${c.id}" id="pvOpen">Open case</a>
    </div>
    <div class="pv-title">Items in this case</div>
    <div class="contents pv-grid">${c.entries.map(e => itemCard(e.item, { extra: `<div class="chance">${(e.chance * 100).toFixed(e.chance < 0.01 ? 3 : e.chance < 0.1 ? 2 : 1)}%</div>` })).join('')}</div>`, { wide: true });
  $('#pvOpen', m.el).onclick = () => m.close();
}

// One delegated listener for every page that shows case cards (eye button only).
if (!(window as any).__casePreview) {
  (window as any).__casePreview = true;
  document.addEventListener('click', e => {
    const b = (e.target as Element).closest('[data-preview]') as HTMLElement | null;
    if (b) { e.preventDefault(); e.stopPropagation(); previewCase(b.dataset.preview as string); }
  }, true);
}
