/* SPDX-License-Identifier: Apache-2.0 */
import { icons } from './icons.js';
export function node(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') e.className = value;
    else e.setAttribute(key, value === true ? '' : String(value));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ws-icon');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', icons[name] || icons.generic); svg.append(path);
  return svg;
}
export const button = (text, attrs = {}) => node('button', { type: 'button', ...attrs }, text);
