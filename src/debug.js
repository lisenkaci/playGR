// Live force-vector overlay. For each particle, sample the four retarded
// fields (E, B, E_g, B_g) at the particle's position and draw arrows for:
//   - Total electromagnetic force F_em = q (E + v x B), colour cyan
//   - Total gravitational force  F_g  = m (E_g + 4 v x B_g), colour magenta
//
// Lengths are log-scaled so arrows from particles of vastly different magnitudes
// remain comparable.

import * as THREE from 'three';
import { physToVisual } from './scale.js';

export class ForceOverlay {
  constructor() {
    this.group = new THREE.Group();
    /** @type {Map<number, {em: THREE.ArrowHelper, g: THREE.ArrowHelper}>} */
    this.arrows = new Map();
  }

  /**
   * @param {Float64Array} snap
   * @param {number} fpp
   * @param {(rx:number,ry:number,rz:number) => Float64Array} sampleFields
   */
  update(snap, fpp, sampleFields) {
    const alive = new Set();
    for (let k = 0; k < snap.length; k += fpp) {
      const id = snap[k] | 0;
      alive.add(id);
      const mass = snap[k + 2];
      const charge = snap[k + 3];
      const rx = snap[k + 5], ry = snap[k + 6], rz = snap[k + 7];
      const vx = snap[k + 8], vy = snap[k + 9], vz = snap[k + 10];

      const f = sampleFields(rx, ry, rz);
      // F_em = q (E + v x B)
      const exB = [
        vy * f[5] - vz * f[4],
        vz * f[3] - vx * f[5],
        vx * f[4] - vy * f[3],
      ];
      const fEM = [
        charge * (f[0] + exB[0]),
        charge * (f[1] + exB[1]),
        charge * (f[2] + exB[2]),
      ];
      // F_g = m (E_g + 4 v x B_g)
      const vxBg = [
        vy * f[11] - vz * f[10],
        vz * f[9]  - vx * f[11],
        vx * f[10] - vy * f[9],
      ];
      const fG = [
        mass * (f[6] + 4 * vxBg[0]),
        mass * (f[7] + 4 * vxBg[1]),
        mass * (f[8] + 4 * vxBg[2]),
      ];

      const [vrx, vry, vrz] = physToVisual([rx, ry, rz]);
      this._setArrow(id, 'em', vrx, vry, vrz, fEM, 0x66e2ff);
      this._setArrow(id, 'g',  vrx, vry, vrz, fG,  0xff66e0);
    }
    for (const [id, arr] of this.arrows) {
      if (alive.has(id)) continue;
      if (arr.em) this.group.remove(arr.em);
      if (arr.g)  this.group.remove(arr.g);
      this.arrows.delete(id);
    }
  }

  _setArrow(id, kind, x, y, z, vec, color) {
    const mag = Math.hypot(vec[0], vec[1], vec[2]);
    if (!isFinite(mag) || mag === 0) return;
    // Log-scaled length, capped so a single huge motor doesn't blow out the view.
    const len = Math.min(6, 0.5 + 0.4 * Math.log10(mag + 1));
    const dir = new THREE.Vector3(vec[0] / mag, vec[1] / mag, vec[2] / mag);
    const origin = new THREE.Vector3(x, y, z);
    let entry = this.arrows.get(id);
    if (!entry) { entry = { em: null, g: null }; this.arrows.set(id, entry); }
    if (!entry[kind]) {
      entry[kind] = new THREE.ArrowHelper(dir, origin, len, color, 0.2, 0.12);
      this.group.add(entry[kind]);
    } else {
      entry[kind].position.copy(origin);
      entry[kind].setDirection(dir);
      entry[kind].setLength(len, 0.2, 0.12);
    }
  }

  setVisible(v) { this.group.visible = v; }
  clear() {
    for (const { em, g } of this.arrows.values()) {
      if (em) this.group.remove(em);
      if (g)  this.group.remove(g);
    }
    this.arrows.clear();
  }
}
