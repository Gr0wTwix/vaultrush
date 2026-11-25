// Warnings from staff (admin site, migration 0021): shown once, the next time the player opens the site, then marked read.
import { call } from './backend.js';
import { esc, modal } from './ui.js';

interface Notice { id: number; message: string; at: string }
let showing = false;

/** Asks the database for unread warnings and shows them one after another. Quietly does nothing before migration 0021 or on any error. */
export async function showNotices(): Promise<void> {
  if (showing) return;
  showing = true;
  try {
    const list = await call<Notice[]>('my_notices').catch(() => [] as Notice[]);
    for (const n of list) await showOne(n);
  } finally { showing = false; }
}

function showOne(n: Notice): Promise<void> {
  return new Promise(resolve => {
    const m = modal('', { locked: true, label: 'A message from the Vaultrush team', onClose: () => resolve() });
    m.el.innerHTML = `<section class="notice-box"><h3>A message from the Vaultrush team</h3><p class="notice-text">${esc(n.message)}</p>
      <p class="muted small">Sent ${esc(new Date(n.at).toLocaleString())}. Repeated problems can lead to a mute or a suspension.</p>
      <div class="row"><button class="btn btn-primary" id="noticeOk" type="button">I understand</button></div></section>`;
    const ok = m.el.querySelector('#noticeOk') as HTMLButtonElement;
    ok.focus();
    ok.onclick = () => { ok.disabled = true; void call('ack_notice', { p_id: n.id }).catch(() => {}).finally(() => m.close()); };
  });
}
