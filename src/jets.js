// Gravitomagnetic "jets" along the spin axis of motors.
//
// A motor in this sandbox is any sufficiently spinning, neutral-or-near-neutral
// mass. We draw two thin cones aligned with the spin vector S, with length
// proportional to log10(|S|+1). The factor is visual only; the underlying B_g
// is computed by the physics engine and shows up correctly in the spacetime
// grid and the force vectors.

import * as THREE from 'three';
import { physToVisual } from './scale.js';

const CONE_GEOM = new THREE.ConeGeometry(0.18, 1.0, 24);
// Cone's apex is at +y, base at -y when not rotated. We want apex pointing
// AWAY from the centre on each side, so each cone's local +y must align with
// the spin axis. Pre-translate so the cone's base sits at origin and the apex
// is at +y = 1.
CONE_GEOM.translate(0, 0.5, 0);

const SPIN_JET_THRESHOLD = 1.0e25; // |S| above which jets become visible

export class JetField {
  constructor() {
    this.group = new THREE.Group();
    /** @type {Map<number, [THREE.Mesh, THREE.Mesh]>} */
    this.cones = new Map();
  }

  syncFromSnapshot(snap, fpp) {
    const alive = new Set();

    for (let k = 0; k < snap.length; k += fpp) {
      const id = snap[k] | 0;
      const mass = snap[k + 2];
      const charge = snap[k + 3];
      const rx = snap[k + 5], ry = snap[k + 6], rz = snap[k + 7];
      const sx = snap[k + 11], sy = snap[k + 12], sz = snap[k + 13];
      const sMag = Math.sqrt(sx * sx + sy * sy + sz * sz);

      // Motor = mass with spin large enough to produce visible B_g, and
      // small-but-not-required net charge (so it's a "GEM motor", not an
      // electromagnet). We hide jets on tiny-spin particles.
      const isMotor = sMag > SPIN_JET_THRESHOLD && mass > 1.0e10 && Math.abs(charge) < 1.0e-3 * mass;
      if (!isMotor) continue;
      alive.add(id);

      let pair = this.cones.get(id);
      if (!pair) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xff6df3,
          transparent: true,
          opacity: 0.55,
        });
        const c1 = new THREE.Mesh(CONE_GEOM, mat);
        const c2 = new THREE.Mesh(CONE_GEOM, mat);
        this.group.add(c1, c2);
        pair = [c1, c2];
        this.cones.set(id, pair);
      }

      // Length: log-scaled so a wide range of motor sizes remains comparable.
      const len = 0.6 + 0.8 * Math.log10(sMag / SPIN_JET_THRESHOLD + 1);

      const [c1, c2] = pair;
      const [px, py, pz] = physToVisual([rx, ry, rz]);
      c1.position.set(px, py, pz);
      c2.position.set(px, py, pz);

      // Orient each cone's +y to spin axis (one along +S, one along -S).
      const upPlus = new THREE.Vector3(sx, sy, sz).normalize();
      const upMinus = upPlus.clone().multiplyScalar(-1);
      const y = new THREE.Vector3(0, 1, 0);
      c1.quaternion.setFromUnitVectors(y, upPlus);
      c2.quaternion.setFromUnitVectors(y, upMinus);

      c1.scale.set(0.7, len, 0.7);
      c2.scale.set(0.7, len, 0.7);
    }

    for (const [id, [c1, c2]] of this.cones) {
      if (!alive.has(id)) {
        this.group.remove(c1, c2);
        c1.material.dispose();
        this.cones.delete(id);
      }
    }
  }

  setVisible(v) { this.group.visible = v; }
}
