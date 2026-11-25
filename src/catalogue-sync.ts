// The cases as the database publishes them (admin step C, migration 0022). The page is built with a copy of the cases (src/data.ts); at start-up it
// asks the database for the live catalogue, fetches any item it does not know yet, and swaps the cases in place. If anything fails (no backend,
// an older database, offline) the bundled cases stay, which are the same as the database's until someone edits a case in the admin site.
import { backendEnabled, call } from './backend.js';
import { ensureItems } from './catalogue.js';
import { applyCatalogue, type PublishedCase } from './data.js';

let applied = '';

/** Loads and applies the published catalogue. Resolves true when the cases changed. Never throws. */
export async function syncCatalogue(): Promise<boolean> {
  if (!backendEnabled()) return false;
  try {
    const pub = await call<{ cases: PublishedCase[] }>('catalogue_public');
    const list = pub?.cases ?? [];
    const sig = list.map(c => `${c.id}:${c.version}`).join(',');
    if (!list.length || sig === applied) return false;
    if (!(await ensureItems(list.flatMap(c => c.entries.map(e => e[0]))))) return false;
    if (!applyCatalogue(list)) return false;
    applied = sig;
    return true;
  } catch { return false; }
}
