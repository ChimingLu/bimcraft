/* SPDX-License-Identifier: Apache-2.0 */
/**
 * handoff-in.js — a model handed over from another app (0.7 LC.1 B1, session `massing`). CivilCraft's "Develop in BimCraft" opens
 * BimCraft at `?handoff=<id>` and stores the IFC in IndexedDB (handoff.js, same origin, nothing uploaded); this takes it, takes the
 * id out of the address, and opens the model as if it had been dropped.
 *
 *   receiveHandoff({ search, open, status, loc, hist }) → Promise<{ file, from, meta } | null>
 *     search  location.search      open(file) → Promise   opens a File as the app does for a drop      status(text, isError)
 * Declared in manifest.json: "accepts": ["mass"] (CivilCraft shows its button only for a build that says so).
 */
import { handoffParam, takeHandoff } from './handoff.js';
import { t } from './i18n.js';

export async function receiveHandoff({ search, open, status = () => {}, loc = globalThis.location, hist = globalThis.history } = {}) {
  const id = handoffParam(search ?? loc?.search ?? '');
  if (!id) return null;
  try {   // the id does not stay in the address (a reload would look for a file that is gone)
    const u = new URLSearchParams(loc.search); u.delete('handoff');
    hist?.replaceState(null, '', loc.pathname + (u.toString() ? '?' + u.toString() : '') + (loc.hash || ''));
  } catch { /* an odd page: leave the address */ }
  const got = await takeHandoff(id);
  if (!got) { status(t('handoff.in.none'), true); return null; }
  await open(got.file);
  status(t('handoff.in.done', { file: got.file.name, app: got.from || '' }), false);
  return got;
}
