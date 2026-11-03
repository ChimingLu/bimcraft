/* SPDX-License-Identifier: Apache-2.0 */
/**
 * session.js — what the renderer keeps for this page only (0.7 RN.3 / RN.8 / RN.11): the sky picture (HDRI) and the colour table
 * (.cube) a person chose. Pictures and tables can be large, so the settings keep only their names; the Render dialog
 * (render-ui.js) and the interactive render in the view (ipr.js) share them through this object. No DOM.
 *
 *   SESSION.hdri = {name, img (lib/exr readHdrImage)} | null      SESSION.lut = {name, lut (lib/exr readCube)} | null
 *   SESSION.volume = {name, vol: {nx, ny, nz, data} (pt-volume.js readCcvol)} | null                       (RN.7)
 *   hdriFor(settings) / lutFor(settings) / volumeFor(settings) → the picture / table / grid when the settings name the one in the session, else null
 */
import { SKIES } from './looks.js';

export const SESSION = { hdri: null, lut: null, volume: null };
export const hdriFor = (s) => (s && SKIES[s.sky]?.hdri && SESSION.hdri ? SESSION.hdri.img : null);
export const lutFor = (s) => (s && s.post && s.post.lutName && SESSION.lut && SESSION.lut.name === s.post.lutName ? SESSION.lut.lut : null);
export const volumeFor = (s) => (s && s.volume && s.volume.on && s.volume.kind === 'file' && SESSION.volume ? SESSION.volume.vol : null);
