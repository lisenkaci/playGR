// Single source of truth for the simulation <-> render coordinate conversion.
//
// Physics is in SI metres. Three.js works best in single-precision floats with
// values of order 1-1000, so we divide every physical position by SCENE_SCALE
// (in metres per visual unit) before sending it to the GPU. The default value
// makes the standard "neutron-star fragment at 1000 km" scenarios fit nicely
// inside a 10-unit camera frustum.

export const SCENE_SCALE_M_PER_UNIT = 1.0e5; // 100 km per visual unit (used for positions)
// Visual radius floor: tiny bodies (sub-km) are floored so the user can still
// see and click them. There is intentionally no *ceiling*: the rendered sphere
// must always be at least as large as the body's hard-sphere collision
// boundary, otherwise the user sees the two spheres bounce off each other
// at a gap. That was the behaviour before this change and was rightly
// complained about.
//
// For bodies near or below the floor, the rendered sphere is *larger* than
// the collision sphere -- so they will visually overlap a bit before the
// physics engine fires its bounce. That's acceptable: it's the unavoidable
// trade-off when displaying many orders of physical scale on one screen,
// and users intuitively read that visual overlap as "they're touching".
export const VISUAL_RADIUS_FLOOR = 0.15;

export function physToVisual([x, y, z]) {
  const s = 1 / SCENE_SCALE_M_PER_UNIT;
  return [x * s, y * s, z * s];
}

export function visualToPhys([x, y, z]) {
  return [x * SCENE_SCALE_M_PER_UNIT, y * SCENE_SCALE_M_PER_UNIT, z * SCENE_SCALE_M_PER_UNIT];
}

/**
 * Map the true physical radius (metres) to a sphere radius (visual units).
 *
 * Above the floor we use the literal SCENE_SCALE conversion
 *   rVisual = rPhys / SCENE_SCALE_M_PER_UNIT
 * so that the rendered sphere is the body's hard-sphere collision boundary.
 * Two bodies bouncing off each other touch visually at the exact moment the
 * engine fires the bounce -- no mysterious "force-field" gap larger than the
 * visible sphere.
 *
 * Below the floor (sub-km bodies) we render the floor value instead. The
 * collision sphere is *smaller* than the rendered sphere in that case, so
 * the rendered spheres will visually overlap a little before the engine
 * fires the bounce. That's the deliberate, acceptable side of the trade-off.
 *
 * Note: there is no upper ceiling. A 7 000 km body will render as a 70-unit
 * sphere and engulf the camera frustum -- which is the correct visual
 * outcome (it really is that big). Use the camera orbit controls and the
 * lattice corner-resize handles to zoom out.
 */
export function physRadiusToVisual(rPhys) {
  if (!isFinite(rPhys) || rPhys <= 0) return VISUAL_RADIUS_FLOOR;
  const v = rPhys / SCENE_SCALE_M_PER_UNIT;
  return Math.max(VISUAL_RADIUS_FLOOR, v);
}
