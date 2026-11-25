// Step C of the admin plan: the case catalogue editor (migration 0022). The database checks every save again (tickets, items, the 70% to 98% return,
// the version) and keeps every version; this page shows the numbers live while you edit so a bad case is caught before it is sent.
import type { CatCase, CatItem, CatSave } from './api.js';
import { errorText } from './api.js';
import { $, $$, coins, esc, reasonDialog, when } from './dom.js';
import type { Page, PageCtx } from './pages.js';

export const TICKETS = 100_000, RTP_MIN = 0.7, RTP_MAX = 0.98, RTP_DEFAULT = 0.9;
interface Row { item: string; name: string; rarity: string; value: number; tickets: number }
interface Draft { id: string; name: string; price: number; hue: number | null; tag: string; art: string; sort: number; reward: boolean; rows: Row[] }

const pct = (tickets: number): string => (tickets / 1000).toFixed(3);
const evOf = (rows: Row[]): number => rows.reduce((s, r) => s + r.value * r.tickets, 0) / TICKETS;
const totalOf = (rows: Row[]): number => rows.reduce((s, r) => s + r.tickets, 0);
/** The problems that would make the database refuse this case, in plain words (empty when it can be saved). */
export function problems(d: Draft, isNew: boolean): string[] {
  const out: string[] = [], total = totalOf(d.rows), ev = evOf(d.rows);
  if (isNew && !/^[a-z0-9-]{2,30}$/.test(d.id)) out.push('The id is 2 to 30 lower-case letters, numbers or dashes.');
  if (d.name.trim().length < 2 || d.name.trim().length > 40) out.push('The name is 2 to 40 characters.');
  if (!d.rows.length || d.rows.length > 60) out.push('A case needs 1 to 60 items.');
  if (d.rows.some(r => !(r.tickets >= 1))) out.push('Every item needs a chance of at least 0.001%.');
  if (total !== TICKETS) out.push(`The chances add up to ${pct(total)}%, not 100%.`);
  if (!d.reward) {
    if (!(d.price > 0)) out.push('Enter a price above 0.');
    else if (ev / d.price < RTP_MIN || ev / d.price > RTP_MAX) out.push(`The return is ${((ev / d.price) * 100).toFixed(1)}%: it must be between ${RTP_MIN * 100}% and ${RTP_MAX * 100}%.`);
  }
  return out;
}

const catalogue: Page = {
  title: 'Catalogue', perm: 'catalogue.view',
  async render(el, c) {
    const canEdit = c.perms.includes('catalogue.edit');
    let list: CatCase[] = [];
    el.innerHTML = `<p class="muted">Every case on the site and what is inside. The game site and the server both read these tables, so a saved change is what players see on their next visit and what every opening draws from. A paid case must return between ${RTP_MIN * 100}% and ${RTP_MAX * 100}% of its price on average (the generated cases return 90%). Every save is a new version you can go back to.</p>
      <div class="row wrap">${canEdit ? '<button class="btn primary" id="kNew">New case</button>' : ''}<label class="chk"><input type="checkbox" id="kOff"> Show switched-off cases</label></div>
      <div id="kList"></div><div id="kEdit"></div>`;
    const drawList = (): void => {
      const showOff = $<HTMLInputElement>('#kOff', el).checked;
      const rows = list.filter(k => showOff || k.active);
      $('#kList', el).innerHTML = `<div class="tablewrap"><table class="grid"><thead><tr><th>Case</th><th>Price</th><th>Return</th><th>Items</th><th>Opened, 7 days</th><th>Version</th><th></th></tr></thead><tbody>${rows.map(k => {
        const rtp = k.price > 0 ? k.ev / k.price : 0;
        return `<tr data-k="${esc(k.id)}"><td><b>${esc(k.name)}</b> <code class="muted small">${esc(k.id)}</code>${k.reward ? ' <span class="pill partial">reward crate</span>' : ''}${k.active ? '' : ' <span class="pill later">off</span>'}${k.in_use ? ' <span class="pill next">in a waiting battle</span>' : ''}</td>
          <td>${coins(k.price)}</td><td>${k.reward ? '<span class="muted small">not sold</span>' : `<span class="${rtp < RTP_MIN || rtp > RTP_MAX ? 'neg' : ''}">${(rtp * 100).toFixed(1)}%</span>`}</td><td>${k.items}</td><td>${k.opens_7d}</td>
          <td>v${k.version}${k.updated_at ? `<br><span class="muted small">${esc(when(k.updated_at))}</span>` : ''}</td>
          <td class="nowrap"><button class="btn ghost" data-open>${canEdit ? 'Edit' : 'View'}</button>${canEdit ? ` <button class="btn ghost" data-toggle>${k.active ? 'Switch off' : 'Switch on'}</button>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="muted">No cases.</td></tr>'}</tbody></table></div>`;
      $$('tr[data-k]', el).forEach(tr => {
        const k = list.find(x => x.id === tr.dataset['k']) as CatCase;
        $('[data-open]', tr).addEventListener('click', () => void openCase(k.id));
        $('[data-toggle]', tr)?.addEventListener('click', async () => {
          const reason = await reasonDialog(`${k.active ? 'Switch off' : 'Switch on'} ${k.name}?`, k.active ? 'It disappears from the site on the next visit and the server refuses to open it. Nothing is deleted; you can switch it on again.' : 'It is back on the site on the next visit.', k.active ? 'Switch off' : 'Switch on');
          if (!reason) return;
          try { await c.api.catalogueSetActive(k.id, !k.active, reason); c.toast('Saved', 'ok'); await load(); } catch (e) { c.toast(errorText(e), 'error'); }
        });
      });
    };
    const load = async (): Promise<void> => { list = await c.api.catalogueCases(); drawList(); };
    $('#kOff', el).addEventListener('change', drawList);

    const openCase = async (id: string | null, from?: Draft): Promise<void> => {
      const box = $('#kEdit', el); box.innerHTML = '<p class="muted">Loading…</p>';
      let version = 0, history: { version: number; at: string; by: string | null; reason: string | null; price: number; items: number }[] = [], inUse = false;
      let d: Draft;
      if (id) {
        try {
          const k = await c.api.catalogueCase(id);
          version = k.version; history = k.history; inUse = k.in_use;
          d = { id: k.id, name: k.name, price: k.price, hue: k.hue, tag: k.tag ?? '', art: k.art ?? '', sort: k.sort, reward: k.reward, rows: k.entries.map(e => ({ item: e.item, name: e.name, rarity: e.rarity, value: e.value, tickets: e.tickets })) };
        } catch (e) { box.innerHTML = `<p class="err" role="alert">${esc(errorText(e))}</p>`; return; }
      } else d = from ?? { id: '', name: '', price: 0, hue: 200, tag: 'new', art: '', sort: 0, reward: false, rows: [] };
      const isNew = !id, ro = !canEdit;
      const dis = ro ? 'disabled' : '';
      box.innerHTML = `<section class="block" id="kEditor"><h2>${isNew ? 'New case' : esc(d.name)} ${isNew ? '' : `<span class="muted small">v${version}</span>`}</h2>
        ${inUse ? '<p class="warn-t">A battle waiting for players uses this case: you can change what is inside, but not the price, until it starts or is cancelled.</p>' : ''}
        <div class="row wrap"><label for="kId">Id</label><input id="kId" value="${esc(d.id)}" ${isNew && !ro ? '' : 'disabled'} placeholder="summer-drop" style="max-width:180px">
          <label for="kName">Name</label><input id="kName" value="${esc(d.name)}" maxlength="40" ${dis} style="max-width:220px">
          <label for="kPrice">Price</label><input id="kPrice" type="number" min="0.01" step="0.01" value="${d.price || ''}" ${dis || (d.reward ? 'disabled' : '')} style="max-width:120px"></div>
        <div class="row wrap"><label for="kHue">Colour (hue 0 to 360)</label><input id="kHue" type="number" min="0" max="360" value="${d.hue ?? ''}" ${dis} style="max-width:90px"><span class="swatch" id="kSwatch"></span>
          <label for="kTag">Label</label><input id="kTag" value="${esc(d.tag)}" maxlength="20" ${dis} style="max-width:130px">
          <label for="kArt">Picture</label><select id="kArt" ${dis} style="max-width:220px"><option value="">Its own (assets/cases/&lt;id&gt;.webp)</option>${list.filter(k => k.id !== d.id).map(k => `<option value="${esc(k.id)}" ${d.art === k.id ? 'selected' : ''}>Same as ${esc(k.name)}</option>`).join('')}</select>
          <label for="kSort">Order</label><input id="kSort" type="number" value="${d.sort}" ${dis} style="max-width:80px"></div>
        <div class="cards" id="kSum"></div>
        <div class="tablewrap"><table class="grid"><thead><tr><th>Item</th><th>Value</th><th>Chance %</th><th>Tickets</th><th>Adds to value</th><th></th></tr></thead><tbody id="kRows"></tbody></table></div>
        ${ro ? '' : `<div class="row wrap"><button class="btn ghost" id="kFill">Put the rest on the most likely item</button><button class="btn ghost" id="kPrice90" ${d.reward ? 'disabled' : ''}>Set the price for a 90% return</button></div>
        <h3>Add items</h3><form id="kFind" class="row wrap"><label class="sr" for="kq">Search items</label><input id="kq" placeholder="Name, e.g. AK-47 Redline" style="max-width:260px">
          <label for="kMin">Value from</label><input id="kMin" type="number" min="0" step="0.01" style="max-width:100px"><label for="kMax">to</label><input id="kMax" type="number" min="0" step="0.01" style="max-width:100px"><button class="btn">Search</button></form><div id="kFound"></div>`}
        <div class="row wrap">${ro ? '' : `<button class="btn primary" id="kSave">${isNew ? 'Create case…' : 'Save as a new version…'}</button>`}<button class="btn ghost" id="kExport">Export JSON</button>${ro ? '' : '<button class="btn ghost" id="kImport">Import JSON…</button>'}<button class="btn ghost" id="kClose">Close</button></div>
        <div id="kProblems" class="err" role="alert"></div>
        ${history.length ? `<h3>Versions</h3><div class="tablewrap"><table class="grid"><thead><tr><th>Version</th><th>When</th><th>Who</th><th>Price</th><th>Items</th><th>Reason</th><th></th></tr></thead><tbody>${history.map(h => `<tr><td>v${h.version}</td><td class="muted small">${esc(when(h.at))}</td><td>${esc(h.by ?? '')}</td><td>${coins(h.price)}</td><td>${h.items}</td><td>${esc(h.reason ?? '')}</td>
          <td>${h.version === version || ro ? '' : `<button class="btn ghost" data-restore="${h.version}">Restore</button>`}</td></tr>`).join('')}</tbody></table></div>` : ''}</section>`;

      const read = (): void => {
        if (isNew) d.id = $<HTMLInputElement>('#kId', box).value.trim().toLowerCase();
        d.name = $<HTMLInputElement>('#kName', box).value; d.price = Math.round(Number($<HTMLInputElement>('#kPrice', box).value) * 100) / 100;
        const hue = $<HTMLInputElement>('#kHue', box).value; d.hue = hue === '' ? null : Math.max(0, Math.min(360, Math.round(Number(hue))));
        d.tag = $<HTMLInputElement>('#kTag', box).value.trim(); d.art = $<HTMLSelectElement>('#kArt', box).value; d.sort = Math.round(Number($<HTMLInputElement>('#kSort', box).value) || 0);
      };
      const drawSummary = (): void => {
        const ev = evOf(d.rows), total = totalOf(d.rows), rtp = d.price > 0 ? ev / d.price : 0, best = d.rows.reduce((m, r) => Math.max(m, r.value), 0);
        $('#kSum', box).innerHTML = `<div class="card"><span class="muted small">Chances add up to</span><b class="${total === TICKETS ? 'pos' : 'neg'}">${pct(total)}%</b><span class="muted small">${total === TICKETS ? 'exactly 100%' : `${total < TICKETS ? 'missing' : 'over by'} ${pct(Math.abs(TICKETS - total))}%`}</span></div>
          <div class="card"><span class="muted small">Average value per opening</span><b>${coins(ev)}</b><span class="muted small">best item ${coins(best)}</span></div>
          <div class="card"><span class="muted small">Return to the player</span><b class="${d.reward ? '' : rtp < RTP_MIN || rtp > RTP_MAX ? 'neg' : 'pos'}">${d.reward ? 'not sold' : `${(rtp * 100).toFixed(1)}%`}</b><span class="muted small">${d.reward ? 'reward crate' : `house keeps ${((1 - rtp) * 100).toFixed(1)}%; allowed ${RTP_MIN * 100}% to ${RTP_MAX * 100}%`}</span></div>
          <div class="card"><span class="muted small">Items</span><b>${d.rows.length}</b><span class="muted small">at most 60</span></div>`;
        $('#kSwatch', box).style.background = d.hue === null ? 'transparent' : `hsl(${d.hue} 80% 55%)`;
        $('#kProblems', box).innerHTML = ro ? '' : problems(d, isNew).map(p => esc(p)).join('<br>');
        const save = $<HTMLButtonElement>('#kSave', box); if (save) save.disabled = problems(d, isNew).length > 0;
      };
      const drawRows = (): void => {
        const ordered = [...d.rows];
        $('#kRows', box).innerHTML = ordered.map((r, i) => `<tr data-i="${i}"><td>${esc(r.name)} <span class="muted small">${esc(r.rarity)}</span></td><td>${coins(r.value)}</td>
          <td><input type="number" min="0.001" max="100" step="0.001" value="${pct(r.tickets)}" data-pct ${dis} style="width:7.5em" aria-label="Chance of ${esc(r.name)} in percent"></td>
          <td class="muted small" data-t>${r.tickets}</td><td class="muted small">${coins((r.value * r.tickets) / TICKETS)}</td>
          <td>${ro ? '' : '<button class="btn ghost" data-rm aria-label="Remove">Remove</button>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No items yet. Search below and add some.</td></tr>';
        $$('tr[data-i]', box).forEach(tr => {
          const r = d.rows[+(tr.dataset['i'] as string)] as Row;
          $<HTMLInputElement>('[data-pct]', tr).addEventListener('input', e => { r.tickets = Math.max(0, Math.round(Number((e.target as HTMLInputElement).value) * 1000)); $('[data-t]', tr).textContent = String(r.tickets); drawSummary(); });
          $('[data-rm]', tr)?.addEventListener('click', () => { d.rows = d.rows.filter(x => x !== r); drawRows(); });
        });
        drawSummary();
      };
      drawRows();
      $$('#kName, #kPrice, #kHue, #kTag, #kArt, #kSort, #kId', box).forEach(i => i.addEventListener('input', () => { read(); drawSummary(); }));
      $('#kFill', box)?.addEventListener('click', () => {
        if (!d.rows.length) return;
        const top = d.rows.reduce((m, r) => (r.tickets > m.tickets ? r : m), d.rows[0] as Row), rest = TICKETS - totalOf(d.rows);
        if (top.tickets + rest < 1) { c.toast('The other items already take more than 100%.', 'error'); return; }
        top.tickets += rest; drawRows();
      });
      $('#kPrice90', box)?.addEventListener('click', () => { const ev = evOf(d.rows); if (!(ev > 0)) return; d.price = Math.round((ev / RTP_DEFAULT) * 100) / 100; $<HTMLInputElement>('#kPrice', box).value = String(d.price); drawSummary(); });
      const kf = $<HTMLFormElement>('#kFind', box);
      if (kf) kf.onsubmit = async e => {
        e.preventDefault();
        const min = Number($<HTMLInputElement>('#kMin', box).value) || 0, maxS = $<HTMLInputElement>('#kMax', box).value;
        let found: CatItem[] = [];
        try { found = await c.api.catalogueItems($<HTMLInputElement>('#kq', box).value, min, maxS === '' ? null : Number(maxS)); } catch (er) { c.toast(errorText(er), 'error'); return; }
        $('#kFound', box).innerHTML = found.length ? `<div class="tablewrap"><table class="grid"><tbody>${found.map(f => `<tr data-f="${esc(f.id)}"><td>${esc(f.name)} <span class="muted small">${esc(f.rarity)}</span></td><td>${coins(f.value)}</td><td>${d.rows.some(r => r.item === f.id) ? '<span class="muted small">in the case</span>' : '<button class="btn ghost" data-add>Add</button>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing found.</p>';
        $$('tr[data-f]', $('#kFound', box)).forEach(tr => $('[data-add]', tr)?.addEventListener('click', () => {
          const f = found.find(x => x.id === tr.dataset['f']) as CatItem;
          if (d.rows.some(r => r.item === f.id)) return;
          d.rows.push({ item: f.id, name: f.name, rarity: f.rarity, value: f.value, tickets: 1000 }); tr.lastElementChild!.innerHTML = '<span class="muted small">added (1%)</span>'; drawRows();
        }));
      };
      const payload = (): CatSave => ({ id: d.id, name: d.name.trim(), price: d.price, hue: d.hue, tag: d.tag || null, art: d.art || null, sort: d.sort, entries: d.rows.map(r => ({ item: r.item, tickets: r.tickets })) });
      $('#kSave', box)?.addEventListener('click', async () => {
        read(); const p = problems(d, isNew); if (p.length) { c.toast(p[0] as string, 'error'); return; }
        const ev = evOf(d.rows);
        const reason = await reasonDialog(isNew ? `Create ${d.name}?` : `Save ${d.name} as version ${version + 1}?`, `${d.rows.length} items, ${d.reward ? 'reward crate' : `price ${coins(d.price)}, return ${((ev / d.price) * 100).toFixed(1)}%`}. Players see it on their next visit.`, isNew ? 'Create' : 'Save');
        if (!reason) return;
        try { const r = await c.api.catalogueSave(payload(), version, reason); c.toast(`Saved as version ${r.version}`, 'ok'); await load(); await openCase(r.id); }
        catch (er) { c.toast(errorText(er), 'error'); }
      });
      $('#kExport', box).addEventListener('click', () => {
        const data = JSON.stringify({ ...payload(), version }, null, 2), a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = `case-${d.id || 'new'}-v${version}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });
      $('#kImport', box)?.addEventListener('click', async () => {
        const text = window.prompt('Paste the JSON of a case (from Export). It fills this editor; nothing is saved until you press Save.'); if (!text) return;
        try {
          const j = JSON.parse(text) as Partial<CatSave>;
          if (!Array.isArray(j.entries)) throw new Error('no entries');
          const known = new Map(d.rows.map(r => [r.item, r]));
          d.name = typeof j.name === 'string' ? j.name : d.name; d.price = typeof j.price === 'number' ? j.price : d.price;
          d.rows = j.entries.map(e => ({ item: String(e.item), name: known.get(String(e.item))?.name ?? String(e.item), rarity: known.get(String(e.item))?.rarity ?? '', value: known.get(String(e.item))?.value ?? 0, tickets: Math.round(Number(e.tickets)) || 0 }));
          $<HTMLInputElement>('#kName', box).value = d.name; $<HTMLInputElement>('#kPrice', box).value = String(d.price || '');
          drawRows(); c.toast('Loaded. Items new to this case show their id until saved; the database checks them on save.', 'ok');
        } catch { c.toast('That is not a case exported from here.', 'error'); }
      });
      $('#kClose', box).addEventListener('click', () => { box.innerHTML = ''; });
      $$('[data-restore]', box).forEach(b => b.addEventListener('click', async () => {
        const v = +(b.dataset['restore'] as string);
        const reason = await reasonDialog(`Restore version ${v} of ${d.name}?`, `Its contents and price come back as version ${version + 1}. Nothing is lost: this version stays in the list.`, 'Restore');
        if (!reason) return;
        try { await c.api.catalogueRestore(d.id, v, reason); c.toast('Restored', 'ok'); await load(); await openCase(d.id); } catch (e) { c.toast(errorText(e), 'error'); }
      }));
      $('#kEditor', box).scrollIntoView({ block: 'start' });
    };
    $('#kNew', el)?.addEventListener('click', () => void openCase(null));
    await load();
  },
};

export const CATALOGUE_PAGES: Record<string, Page> = { catalogue };
export type { PageCtx };
