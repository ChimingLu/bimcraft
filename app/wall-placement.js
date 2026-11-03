/* SPDX-License-Identifier: Apache-2.0 */
import { locationOffset, typeThickness } from './model-walls.js';
import { wallPath } from './model-tools.js';
import { t as tr } from './i18n.js';

// UI references map to the existing IFC justification contract. No second geometry or unit system.
export const WALL_LOCATION_LINES = ['center', 'exterior', 'interior', 'coreCenter', 'coreExterior', 'coreInterior'];
export function placementReference(reference, type, side) {
  const justification = reference === 'outside' ? 'exterior' : reference === 'inside' ? 'interior' : reference;
  if (!WALL_LOCATION_LINES.includes(justification) || !['left', 'right'].includes(side)) throw new Error(tr('wall.err.location_line'));
  if (!type) throw new Error(tr('wall.err.type_missing'));
  const thickness = typeThickness(type), offset = locationOffset(justification, thickness, side, type);
  if (!Number.isFinite(offset)) throw new Error(tr('wall.err.no_core'));
  return { justification, thickness, axisOffset: -offset };
}
export function placementPath(points, type, reference, side) {
  const spec = placementReference(reference, type, side);
  return wallPath(points, spec.thickness, 'center', side, spec.axisOffset);
}
