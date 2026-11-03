/* SPDX-License-Identifier: Apache-2.0 */
/**
 * media-ui.js — the Render dialog's fog, smoke-or-cloud volume and noise controls (0.7 RN.7). Built with the dialog's own `el`
 * and `t`; render-ui.js puts `fs` in its form, merges `read()` into the settings it reads and calls `sync(hq)` when the form
 * changes. The volume file the person chose stays in the page's session (session.js), like the sky picture.
 *
 *   mountMedia({ el, t, settings, SESSION, readCcvol, onStatus, blocked }) → { fs, read() → {fog, volume, adaptive, caustics}, sync(hq) }
 *   blocked() → true while light mixing or render elements are on (caustics do not combine with them)
 */
import { VOLUME_KINDS, VOLUME_RES } from './looks.js';

const MAX_VOLUME_FILE = 64 * 1024 * 1024;

export function mountMedia({ el, t, settings, SESSION, readCcvol, onStatus = () => {}, blocked = () => false }) {
  const fog = settings.fog, vol = settings.volume, ad = settings.adaptive;
  const out = () => el('output', {}, '');
  const slider = (min, max, step, value, key) => el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), dataset: { [key]: '' } });
  const number = (min, max, step, value, key) => el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(value), dataset: { [key]: '' } });

  // ---- fog ----
  const fogOn = el('input', { type: 'checkbox', checked: fog.on, dataset: { renderFogOn: '' } });
  const visIn = number(5, 20000, 5, fog.visibility, 'renderFogVisibility');
  const topIn = number(1, 5000, 1, fog.top, 'renderFogTop');
  const leanIn = slider(-0.9, 0.9, 0.05, fog.g, 'renderFogLean'), leanOut = out();
  const fogColor = el('input', { type: 'color', value: fog.color, dataset: { renderFogColor: '' } });
  const fogRows = el('div', { dataset: { renderFogRows: '' } },
    el('label', {}, t('render.fog.visibility'), visIn),
    el('label', {}, t('render.fog.top'), topIn),
    el('label', {}, el('span', {}, t('render.fog.lean'), ' ', leanOut), leanIn),
    el('label', {}, t('render.fog.color'), fogColor),
    el('p', { className: 'cc-render-note' }, t('render.fog.note')));

  // ---- one smoke or cloud volume ----
  const volOn = el('input', { type: 'checkbox', checked: vol.on, dataset: { renderVolOn: '' } });
  const kindSel = el('select', { className: 'select-cc', dataset: { renderVolKind: '' } }, VOLUME_KINDS.map((k) => el('option', { value: k, selected: k === vol.kind }, t('render.vol.kind.' + k))));
  const resSel = el('select', { className: 'select-cc', dataset: { renderVolRes: '' } }, VOLUME_RES.map((n) => el('option', { value: String(n), selected: n === vol.res }, t('render.vol.res.n', { n }))));
  const seedIn = number(1, 9999, 1, vol.seed, 'renderVolSeed');
  const volFile = el('input', { type: 'file', accept: '.ccvol', className: 'visually-hidden', dataset: { renderVolFile: '' } });
  const volBtn = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { renderVolPick: '' } }, t('render.vol.pick'));
  const volName = el('span', { className: 'cc-render-note', dataset: { renderVolName: '' } }, '');
  const sizeIn = number(0, 10000, 0.5, vol.size, 'renderVolSize');
  const dxIn = number(-5000, 5000, 0.5, vol.dx, 'renderVolDx'), dyIn = number(-5000, 5000, 0.5, vol.dy, 'renderVolDy'), dzIn = number(-5000, 5000, 0.5, vol.dz, 'renderVolDz');
  const yawIn = slider(-180, 180, 5, vol.yaw, 'renderVolYaw'), yawOut = out();
  const denIn = slider(0.05, 5, 0.05, Math.min(5, vol.density), 'renderVolDensity'), denOut = out();
  const vLeanIn = slider(-0.9, 0.9, 0.05, vol.g, 'renderVolLean'), vLeanOut = out();
  const volColor = el('input', { type: 'color', value: vol.color, dataset: { renderVolColor: '' } });
  const presetRows = el('div', { dataset: { renderVolPreset: '' } }, el('label', {}, t('render.vol.res'), resSel), el('label', {}, t('render.vol.seed'), seedIn));
  const fileRows = el('div', { className: 'cc-render-check', dataset: { renderVolFileRows: '' } }, volBtn, volName, volFile);
  const volRows = el('div', { dataset: { renderVolRows: '' } },
    el('label', {}, t('render.vol.kind'), kindSel),
    presetRows, fileRows,
    el('label', {}, t('render.vol.size'), sizeIn),
    el('div', { className: 'cc-render-xyz' }, el('label', {}, t('render.vol.dx'), dxIn), el('label', {}, t('render.vol.dy'), dyIn), el('label', {}, t('render.vol.dz'), dzIn)),
    el('label', {}, el('span', {}, t('render.vol.yaw'), ' ', yawOut), yawIn),
    el('label', {}, el('span', {}, t('render.vol.density'), ' ', denOut), denIn),
    el('label', {}, el('span', {}, t('render.vol.lean'), ' ', vLeanOut), vLeanIn),
    el('label', {}, t('render.vol.color'), volColor),
    el('p', { className: 'cc-render-note' }, t('render.vol.note')));
  volBtn.addEventListener('click', () => volFile.click());
  volFile.addEventListener('change', async () => {
    const f = volFile.files && volFile.files[0];
    volFile.value = '';
    if (!f) return;
    if (f.size > MAX_VOLUME_FILE) { onStatus(t('render.vol.too_big')); return; }
    try {
      const v = readCcvol(new Uint8Array(await f.arrayBuffer()));
      SESSION.volume = { name: f.name, vol: v };
      onStatus(t('render.vol.loaded', { file: f.name, nx: v.nx, ny: v.ny, nz: v.nz }));
      volFile.dispatchEvent(new Event('change', { bubbles: true }));   // the form notices (a new name in the settings)
    } catch (e) { onStatus(t('render.vol.bad', { error: String(e?.code || e?.message || e) })); }
  });

  // ---- noise ----
  const adOn = el('input', { type: 'checkbox', checked: ad.on, dataset: { renderAdaptiveOn: '' } });
  const noiseIn = slider(0.5, 10, 0.5, Math.round(ad.noise * 1000) / 10, 'renderAdaptiveNoise'), noiseOut = out();
  const adRows = el('div', { dataset: { renderAdaptiveRows: '' } },
    el('label', {}, el('span', {}, t('render.adaptive.noise'), ' ', noiseOut), noiseIn),
    el('p', { className: 'cc-render-note' }, t('render.adaptive.note')));

  // ---- caustics ----
  const causticsIn = el('input', { type: 'checkbox', checked: settings.caustics, dataset: { renderCausticsOn: '' } });
  const causticsNote = el('p', { className: 'cc-render-note', dataset: { renderCausticsNote: '' } }, '');

  const fs = el('fieldset', { dataset: { renderMediaFs: '' } }, el('legend', {}, t('render.media')),
    el('label', { className: 'cc-render-check' }, fogOn, t('render.fog.on')), fogRows,
    el('label', { className: 'cc-render-check' }, volOn, t('render.vol.on')), volRows,
    el('label', { className: 'cc-render-check' }, adOn, t('render.adaptive.on')), adRows,
    el('label', { className: 'cc-render-check' }, causticsIn, t('render.caustics.on')), causticsNote);

  let fileName = vol.name;
  return {
    fs,
    read() {
      return {
        fog: { on: fogOn.checked, visibility: Number(visIn.value), top: Number(topIn.value), g: Number(leanIn.value), color: fogColor.value },
        volume: { on: volOn.checked, kind: kindSel.value, name: SESSION.volume ? SESSION.volume.name : fileName, dx: Number(dxIn.value), dy: Number(dyIn.value), dz: Number(dzIn.value), size: Number(sizeIn.value), yaw: Number(yawIn.value), density: Number(denIn.value), g: Number(vLeanIn.value), color: volColor.value, res: Number(resSel.value), seed: Number(seedIn.value) },
        adaptive: { on: adOn.checked, noise: Number(noiseIn.value) / 100, min: ad.min },
        caustics: causticsIn.checked,
      };
    },
    sync(hq, current) {
      if (current) fileName = current.volume.name;
      fs.hidden = !hq;
      fogRows.hidden = !fogOn.checked;
      volRows.hidden = !volOn.checked;
      adRows.hidden = !adOn.checked;
      presetRows.hidden = kindSel.value === 'file';
      fileRows.hidden = kindSel.value !== 'file';
      // caustics trace light from the lamps and the sun: they do not combine with media, light mixing or render elements
      const noCaustics = blocked() || fogOn.checked || volOn.checked;
      causticsIn.disabled = noCaustics;
      causticsNote.textContent = t(noCaustics ? 'render.caustics.blocked' : 'render.caustics.note');
      leanOut.value = String(Number(leanIn.value));
      vLeanOut.value = String(Number(vLeanIn.value));
      yawOut.value = yawIn.value + '°';
      denOut.value = String(Number(denIn.value));
      noiseOut.value = noiseIn.value + ' %';
      volName.textContent = SESSION.volume ? SESSION.volume.name : fileName ? t('render.vol.again', { file: fileName }) : t('render.vol.none');
    },
  };
}
