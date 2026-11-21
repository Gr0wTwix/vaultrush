// Small helpers for the admin site. It has no dependency on the game site's state or UI, so it stays a separate, smaller program.
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll(sel)] as T[];
export const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : '');
/** Coins with two decimals and thousands separators (1,234.50). */
export const coins = (n: unknown): string => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const mmss =(ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function toast(msg: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  const box = document.getElementById('toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  box.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

/** A dialog that asks for a short reason (at least 3 characters). Resolves with the reason, or null if cancelled. Every admin change needs one. */
export function reasonDialog(title: string, detail: string, confirmLabel = 'Confirm'): Promise<string | null> {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'dlg-back';
    back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgT"><h2 id="dlgT">${esc(title)}</h2><p class="muted">${esc(detail)}</p>
      <label for="dlgReason">Reason (shown in the audit log)</label><textarea id="dlgReason" rows="3" maxlength="300" placeholder="Why are you doing this?"></textarea>
      <div class="dlg-err" id="dlgErr" role="alert"></div>
      <div class="row"><button class="btn ghost" id="dlgNo">Cancel</button><button class="btn danger" id="dlgYes">${esc(confirmLabel)}</button></div></div>`;
    document.body.append(back);
    const box = $<HTMLTextAreaElement>('#dlgReason', back);
    box.focus();
    const done = (v: string | null): void => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    $('#dlgNo', back).onclick = () => done(null);
    $('#dlgYes', back).onclick = () => { const v = box.value.trim(); if (v.length < 3) { $('#dlgErr', back).textContent = 'Write a short reason (at least 3 characters).'; box.focus(); return; } done(v); };
  });
}
