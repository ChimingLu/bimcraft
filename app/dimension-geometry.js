/* SPDX-License-Identifier: Apache-2.0 */
/** Model-space footprint for persistent dimensions, shared by fit and print bounds.
 * Auto dimensions use a screen/paper offset and keep the existing fit padding. */
export function dimensionFootprint(d) {
  const length = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
  const points = [d.a, d.b, ...(d.witnesses || [])];
  if (length < 0.001 || d.offPx !== undefined || d.offMm !== undefined) return points;
  const normal = [-(d.b[1] - d.a[1]) / length, (d.b[0] - d.a[0]) / length];
  return [...points, ...[d.a, d.b].map(p => p.map((v, i) => v + normal[i] * (d.off || 0)))];
}
