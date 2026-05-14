// Three.js scene management: camera, lights, orbit controls, particle meshes.
//
// We render each particle as a glowing sphere whose size is its physical radius
// (after the SCENE_SCALE conversion) clamped above a small visibility floor.
// Charge colours it (red = positive, cyan = negative, white = neutral); spin
// magnitude tints it brighter and adds a faint corona.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { physToVisual, physRadiusToVisual } from './scale.js';

const SPHERE_GEOM = new THREE.SphereGeometry(1, 24, 16);

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    // Very weak distance fog: barely affects anything closer than ~500 visual
    // units (so the local scene stays bright at any camera distance), and only
    // gently fades the star-field shell at ~4000 units to give some depth.
    this.scene.fog = new THREE.FogExp2(0x040813, 0.0008);

    // Far clip set generously so a fast-moving body that has flown thousands
    // of visual units away (a real outcome for solar-mass bodies at v ~ 0.5c)
    // is still rendered when the user re-frames the scene.
    this.camera = new THREE.PerspectiveCamera(
      55, canvas.clientWidth / canvas.clientHeight, 0.01, 1e9,
    );
    this.camera.position.set(12, 8, 18);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 5e7;

    // Lighting: a bright ambient + hemisphere combo keeps particles legible
    // from any camera angle regardless of how far the auto-fit pulls back.
    // We do not rely on distance-attenuated point lights because the camera
    // distance can range from ~10 to ~500 visual units across presets.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xc8d6ff, 0x331a55, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(8, 10, 6);
    this.scene.add(dir);

    // Distant star field
    const starsGeom = new THREE.BufferGeometry();
    const N = 2000;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 4000 + Math.random() * 2000;
      const t = Math.random() * Math.PI * 2;
      const u = Math.acos(2 * Math.random() - 1);
      pos[3 * i + 0] = r * Math.sin(u) * Math.cos(t);
      pos[3 * i + 1] = r * Math.sin(u) * Math.sin(t);
      pos[3 * i + 2] = r * Math.cos(u);
    }
    starsGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(
      starsGeom,
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.65 }),
    );
    this.scene.add(stars);

    // Particle pool
    /** @type {Map<number, THREE.Mesh>} */
    this.meshes = new Map();
    /** @type {THREE.Group} */
    this.particleGroup = new THREE.Group();
    this.scene.add(this.particleGroup);

    // Tracking: when the scene goes from empty to non-empty, fit camera once.
    this._wasEmpty = true;

    // Resize handling
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  _resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Sync the live particle meshes to the current snapshot. Spheres scale to
   * the particle's physical radius, are coloured by charge, and dim with
   * gamma (the relativistic Doppler-headlight effect produces forward-beamed
   * radiation; we approximate visually with a brightness factor).
   *
   * @param {Float64Array} snap - the flat snapshot from physicsBridge
   * @param {number} fpp - floats per particle
   */
  syncParticles(snap, fpp) {
    const alive = new Set();
    for (let k = 0; k < snap.length; k += fpp) {
      const id = snap[k] | 0;
      alive.add(id);
      const mass = snap[k + 2];
      const charge = snap[k + 3];
      const radius = snap[k + 4];
      const rx = snap[k + 5], ry = snap[k + 6], rz = snap[k + 7];
      const vx = snap[k + 8], vy = snap[k + 9], vz = snap[k + 10];
      const gamma = snap[k + 14];

      let mesh = this.meshes.get(id);
      if (!mesh) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0x222244,
          emissiveIntensity: 1.0,
          metalness: 0.1, roughness: 0.5,
        });
        mesh = new THREE.Mesh(SPHERE_GEOM, mat);
        mesh.userData = { id };
        this.particleGroup.add(mesh);
        this.meshes.set(id, mesh);
      }
      // The dragger reads this to know which particle the mesh maps to.
      mesh.userData.id = id;

      const [vx_v, vy_v, vz_v] = physToVisual([rx, ry, rz]);
      mesh.position.set(vx_v, vy_v, vz_v);
      const vr = physRadiusToVisual(radius);
      mesh.scale.setScalar(vr);

      // Colour by charge: red = positive, cyan = negative, near-white = neutral
      let col;
      if (charge > 0) col = new THREE.Color(1.0, 0.45 - Math.min(0.4, charge * 1e-3), 0.45 - Math.min(0.4, charge * 1e-3));
      else if (charge < 0) col = new THREE.Color(0.45, 0.85, 1.0);
      else col = new THREE.Color(0.9, 0.95, 1.0);
      // Mass-dominant bodies get a yellow-white shift
      if (mass > 1e22 && charge === 0) col.lerp(new THREE.Color(1.0, 0.92, 0.7), 0.6);
      mesh.material.color.copy(col);
      mesh.material.emissive.copy(col).multiplyScalar(0.6);
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const beta = Math.min(0.999, speed / 2.99792458e8);
      mesh.material.emissiveIntensity = 0.9 + 1.6 * beta;
    }

    // Remove meshes for particles that no longer exist (e.g. after a merger).
    for (const [id, mesh] of this.meshes) {
      if (alive.has(id)) continue;
      this.particleGroup.remove(mesh);
      mesh.material.dispose();
      this.meshes.delete(id);
    }

    // Auto-fit the camera the first time the scene becomes non-empty.
    if (this._wasEmpty && this.meshes.size > 0) {
      this.fitCameraToParticles();
    }
    this._wasEmpty = this.meshes.size === 0;
  }

  /**
   * Move the camera so every alive particle is comfortably inside the frustum.
   *
   * The orbit target is ALWAYS the grid centre (the world origin). This is
   * deliberate: the spacetime lattice is the fixed lab frame, and using it
   * as the orbit pivot guarantees the camera never "locks onto" some drifting
   * body centroid. We size the camera distance to encompass the furthest
   * body from the origin, with a small floor so sub-atomic spawns don't zoom
   * into the void and a ceiling so wildly-spread bodies don't pull the
   * camera into the next time zone.
   */
  fitCameraToParticles() {
    if (this.meshes.size === 0) return;
    // Worst-case distance from the origin to any particle's far edge.
    let maxR = 0;
    for (const mesh of this.meshes.values()) {
      mesh.updateMatrixWorld();
      const sphereR = mesh.scale.x;
      const d = mesh.position.length() + sphereR;
      if (d > maxR) maxR = d;
    }
    const MIN_DIAMETER = 12;
    const MAX_DIAMETER = 120;
    const diameter = Math.min(MAX_DIAMETER, Math.max(MIN_DIAMETER, 2 * maxR));
    this._dollyToOrigin(diameter);
  }

  /**
   * Frame an arbitrary bounding box. Unlike `fitCameraToParticles` this does
   * NOT apply a MAX_DIAMETER cap -- the caller is explicitly asking to see
   * everything in `box`, so we let the camera pull back as far as needed.
   * Used by the "Frame all bodies" button which feeds in a box that always
   * contains both the body positions AND the lattice cube at the origin, so
   * the user never ends up looking at empty space far away from the grid.
   * The orbit target is locked to the world origin, same as fitCameraToParticles.
   *
   * @param {THREE.Box3} box - bounding box to frame, in visual-unit space.
   */
  frameBox(box) {
    if (box.isEmpty()) return;
    // Furthest extent of the box in any single axis, taken about the origin.
    // Using this (rather than the box's own diagonal) keeps the camera
    // anchored to the grid centre instead of drifting toward the box's mid.
    const min = box.min, max = box.max;
    const rx = Math.max(Math.abs(min.x), Math.abs(max.x));
    const ry = Math.max(Math.abs(min.y), Math.abs(max.y));
    const rz = Math.max(Math.abs(min.z), Math.abs(max.z));
    const diameter = Math.max(12, 2 * Math.max(rx, ry, rz));
    this._dollyToOrigin(diameter);
  }

  /**
   * Shared helper: place the camera so the world origin is the orbit
   * target and `diameter` visual units fit horizontally and vertically.
   * Preserves the camera's current viewing direction (so the user's
   * preferred angle is kept on Frame All).
   */
  _dollyToOrigin(diameter) {
    const origin = new THREE.Vector3(0, 0, 0);
    const fov = this.camera.fov * Math.PI / 180;
    const dist = 1.4 * diameter / Math.tan(fov / 2);

    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() === 0 || !isFinite(dir.length())) dir.set(1, 0.7, 1).normalize();
    this.controls.target.copy(origin);
    this.camera.position.copy(origin).add(dir.multiplyScalar(Math.max(dist, 14)));
    this.camera.lookAt(origin);
    this.controls.update();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
