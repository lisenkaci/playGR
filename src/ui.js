// DOM-side controls: preset buttons, custom spawn form, time-scale, toggles,
// scene save/load, and the diagnostics readout.
//
// All values are passed to physicsBridge in real SI units; the UI does no
// scaling. The 'time scale' slider is logarithmic and controls how many
// *physics seconds* of simulation should elapse per *wall second* of real time.

import { PRESET_SECTIONS } from './presets.js';
import { captureScene, downloadJSON, readSceneFile, applyScene } from './persistence.js';
import { visualToPhys, SCENE_SCALE_M_PER_UNIT } from './scale.js';

const $ = (id) => document.getElementById(id);

function parseVec3(str) {
  const parts = str.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`expected 3 comma-separated numbers, got "${str}"`);
  }
  return parts;
}

function toast(msg, kind = '') {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = kind; el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2400);
}

export class UI {
  /**
   * @param {object} ctx
   * @param {import('./physicsBridge.js').PhysicsBridge} ctx.bridge
   * @param {import('./grid.js').SpacetimeGrid} ctx.grid
   * @param {import('./flow.js').SpacetimeFlow} ctx.flow
   * @param {import('./jets.js').JetField} ctx.jets
   * @param {import('./debug.js').ForceOverlay} ctx.forces
   * @param {() => number[]} [ctx.getSpawnAnchorPhys] - returns [x,y,z] in
   *        physical metres that any "at origin" preset spec.r should be
   *        translated by. Used to spawn into the camera's centre of attention.
   * @param {() => void} [ctx.onFrameAll] - "Frame all bodies" button hook.
   * @param {() => void} ctx.onReset
   */
  constructor({ bridge, grid, flow, jets, forces, getSpawnAnchorPhys, onFrameAll, onReset }) {
    this.bridge = bridge;
    this.grid = grid;
    this.flow = flow;
    this.jets = jets;
    this.forces = forces;
    this.getSpawnAnchorPhys = getSpawnAnchorPhys || (() => [0, 0, 0]);
    this.onFrameAll = onFrameAll || (() => {});
    this.onReset = onReset;

    // Per-wall-second physics-time scaling. Default set by the slider's value
    // attribute in index.html.
    this.timeScale = 1.0e-1;
    this.paused = false;
    this.showForces = false;
    this.mergerDefault = false;
    this.clickToSpawn = false;

    /** @type {number|null} The id of the currently inspected/selected body. */
    this.selectedId = null;

    this._buildPresets();
    this._wireSimControls();
    this._wireManualSpawn();
    this._wireSceneIO();
    this._wireInspector();
  }

  _wireInspector() {
    const delBtn = $('ins-delete-btn');
    if (delBtn) delBtn.addEventListener('click', () => this._deleteSelected());

    // Global Delete / Backspace shortcut, but only when the user is *not*
    // currently typing into a text input or contenteditable element. This
    // matches the convention used by file managers and CAD tools.
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
      const t = ev.target;
      const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      if (this.selectedId == null) return;
      ev.preventDefault();
      this._deleteSelected();
    });
  }

  _deleteSelected() {
    if (this.selectedId == null) return;
    const ok = this.bridge.remove(this.selectedId);
    toast(ok ? `Deleted body ${this.selectedId}` : `Body ${this.selectedId} not found`, ok ? '' : 'warn');
    this.setSelected(null);
  }

  /** Set the inspected body. Pass null to clear. Called by InteractionHandler. */
  setSelected(id) {
    this.selectedId = (typeof id === 'number' && id > 0) ? id : null;
    const empty   = $('ins-empty');
    const table   = $('ins-table');
    const delBtn  = $('ins-delete-btn');
    const idSpan  = $('ins-id');
    if (this.selectedId == null) {
      if (empty)  empty.hidden  = false;
      if (table)  table.hidden  = true;
      if (delBtn) delBtn.hidden = true;
      if (idSpan) idSpan.textContent = '';
    } else {
      if (empty)  empty.hidden  = true;
      if (table)  table.hidden  = false;
      if (delBtn) delBtn.hidden = false;
      if (idSpan) idSpan.textContent = `#${this.selectedId}`;
    }
  }

  _buildPresets() {
    const wrap = document.querySelector('#presets .preset-grid');
    // The container is a single grid; each section gets a full-width header
    // plus its own row of preset buttons. Headers use class "preset-section"
    // and the CSS spans them across both columns.
    for (const section of PRESET_SECTIONS) {
      const header = document.createElement('div');
      header.className = 'preset-section';
      header.textContent = section.label;
      wrap.appendChild(header);
      for (const preset of section.presets) {
        const btn = document.createElement('button');
        btn.textContent = preset.label;
        btn.title = preset.desc;
        btn.addEventListener('click', () => this._applyPreset(preset));
        wrap.appendChild(btn);
      }
    }
  }

  _applyPreset(preset) {
    // Translate every spec.r by the current spawn anchor (camera target).
    // Multi-body presets keep their relative geometry; the whole group gets
    // shifted so it appears where the user is currently looking.
    // Also: the "Mergers default-on" UI checkbox can force-enable mergers on
    // any preset, since by default presets bounce so the user can see actual
    // collision dynamics (instead of one body silently absorbing another).
    const anchor = this.getSpawnAnchorPhys();
    const shift = (spec) => ({
      ...spec,
      r: [
        (spec.r?.[0] ?? 0) + anchor[0],
        (spec.r?.[1] ?? 0) + anchor[1],
        (spec.r?.[2] ?? 0) + anchor[2],
      ],
      allow_merger: !!spec.allow_merger || this.mergerDefault,
    });

    let failures = [];
    let spawned = 0;
    if (preset.multi) {
      for (const spec of preset.multi) {
        const r = this.bridge.spawn(shift(spec));
        if (!r.ok) failures.push(r.error); else spawned++;
      }
    } else if (preset.spec) {
      const r = this.bridge.spawn(shift(preset.spec));
      if (!r.ok) failures.push(r.error); else spawned++;
    }
    if (failures.length) toast(`Spawn failed: ${failures[0]}`, 'warn');
    else toast(`Spawned: ${preset.label} (${spawned})`);
  }

  _wireSimControls() {
    const slider = $('time-scale');
    const ro = $('time-scale-readout');
    const update = () => {
      const exp = parseFloat(slider.value);
      this.timeScale = Math.pow(10, exp);
      ro.textContent = this.timeScale.toExponential(2);
    };
    slider.addEventListener('input', update);
    update();

    const cellSlider = $('cell-density');
    const cellRo = $('cell-density-readout');
    if (cellSlider) {
      // The same slider drives the lattice cell count (N vertices per axis)
      // AND the river tracer count. The river maps cell count to tracer
      // count via a cubic ramp that's clamped so the high end stays
      // visually dense without overwhelming the GPU.
      //
      //   N=6  -> ~400 tracers     (sparse, snappy)
      //   N=11 -> ~1300 tracers    (default, looks like a flowing grid)
      //   N=25 -> ~2500 tracers    (capped from N^3=15625 for the GPU)
      const flowTracerCount = (N) => Math.max(400, Math.min(2500, N * N * N));
      cellSlider.value = String(this.grid.getCellCount());
      cellRo.textContent = cellSlider.value;
      if (this.flow) this.flow.setCount(flowTracerCount(this.grid.getCellCount()));
      cellSlider.addEventListener('input', () => {
        const n = parseInt(cellSlider.value, 10);
        cellRo.textContent = String(n);
        this.grid.setCellCount(n);
        if (this.flow) this.flow.setCount(flowTracerCount(n));
      });
    }

    // Wire each toggle to BOTH (a) the canonical state (this.grid, this.flow,
    // etc.) at startup and (b) a 'change' listener for future user clicks.
    // Without the startup sync the checkbox can disagree with the mesh
    // visibility -- e.g. after a bfcache restore the browser may bring back
    // a previously-checked "Spacetime river" while the constructor set
    // `this.flow.mesh.visible = false`. That looked like buggy selection
    // logic ("I checked it but nothing happens", "I unchecked it but it's
    // still there") and only sometimes reproduced, because it depended on
    // the browser's form-restoration behaviour.
    const bindCheckbox = (id, apply) => {
      const el = $(id);
      if (!el) return;
      apply(el.checked);
      el.addEventListener('change', (e) => apply(e.target.checked));
    };

    bindCheckbox('pause',          (v) => { this.paused = v; });
    bindCheckbox('show-grid',      (v) => this.grid.setVisible(v));
    if (this.flow) {
      bindCheckbox('show-flow',    (v) => this.flow.setVisible(v));
    }
    bindCheckbox('show-jets',      (v) => this.jets.setVisible(v));
    bindCheckbox('show-forces',    (v) => {
      this.showForces = v;
      this.forces.setVisible(v);
      if (!v) this.forces.clear();
    });
    bindCheckbox('mergers-default', (v) => { this.mergerDefault = v; });
    $('reset-btn').addEventListener('click', () => {
      this.bridge.clear();
      this.forces.clear();
      if (this.onReset) this.onReset();
      toast('Scene cleared');
    });
    $('frame-all-btn').addEventListener('click', () => {
      this.onFrameAll();
      toast('Camera re-framed');
    });
  }

  _wireManualSpawn() {
    $('spawn-btn').addEventListener('click', () => this._spawnFromForm());
    const cts = $('click-to-spawn');
    if (cts) {
      this.clickToSpawn = cts.checked;
      cts.addEventListener('change', (e) => { this.clickToSpawn = e.target.checked; });
    }
  }

  /**
   * Read every field of the custom-particle form and emit a spawn spec. Used
   * both by the "Spawn at origin" button and by the click-to-spawn handler,
   * which calls this with an override position from the raycast.
   *
   * @param {number[]|null} positionOverride - if non-null, replaces the form's
   *        Position field for this one spawn (in physical metres).
   * @returns {{id:number, ok:boolean, error?:string} | null}
   */
  _spawnFromForm(positionOverride = null) {
    try {
      const mass = Number($('f-mass').value);
      const charge = Number($('f-charge').value);
      const radius = Number($('f-radius').value);
      const r = positionOverride ?? parseVec3($('f-pos').value);
      const v = parseVec3($('f-vel').value);
      const axis = parseVec3($('f-spin-axis').value);
      const omega = Number($('f-spin-omega').value);
      // S = I omega = (2/5) m r^2 omega along the (normalised) axis.
      const an = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      const I = 0.4 * mass * radius * radius;
      const S = I * omega;
      const spin = [axis[0]/an * S, axis[1]/an * S, axis[2]/an * S];
      const allow_merger = $('f-allow-merger').checked || this.mergerDefault;
      const res = this.bridge.spawn({ mass, charge, radius, r, v, spin, allow_merger });
      if (!res.ok) toast(`Spawn failed: ${res.error}`, 'err');
      else toast(`Spawned id ${res.id}`);
      return res;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    }
  }

  /**
   * Public hook called by InteractionHandler when the user clicks empty
   * space with click-to-spawn enabled. Returns the bridge result
   * `{id, ok, error}` so the caller can keep teleporting the just-spawned
   * body while the user drags it into a precise position.
   */
  spawnAtVisualPoint(visualXYZ) {
    const phys = visualToPhys([visualXYZ.x, visualXYZ.y, visualXYZ.z]);
    return this._spawnFromForm(phys);
  }

  _wireSceneIO() {
    $('save-btn').addEventListener('click', () => {
      const obj = captureScene(this.bridge, this.grid.visualGain);
      downloadJSON(obj);
      toast('Scene downloaded');
    });
    const fileInput = $('load-file');
    $('load-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const scene = await readSceneFile(file);
        const failures = applyScene(this.bridge, scene);
        if (typeof scene.visual_gain === 'number') this.grid.setGain(scene.visual_gain);
        if (failures.length) toast(`Loaded with ${failures.length} skipped`, 'warn');
        else toast(`Loaded ${scene.particles.length} particles`);
      } catch (err) {
        toast(`Load failed: ${err.message}`, 'err');
      } finally {
        fileInput.value = '';
      }
    });
  }

  /** Called every frame with the latest world state. */
  refreshDiagnostics(bridge) {
    $('d-n').textContent = bridge.aliveCount;
    $('d-e').textContent = formatExp(bridge.totalEnergy);
    const [px, py, pz] = bridge.totalMomentum();
    $('d-p').textContent = formatExp(Math.hypot(px, py, pz));
    $('d-gamma').textContent = bridge.maxGamma.toFixed(4);
    $('d-bg').textContent = formatExp(bridge.maxBg);
    $('d-steps').textContent = bridge.lastStepCount;
    $('d-t').textContent = formatExp(bridge.t);
  }

  /**
   * Update the Body Inspector panel from the current frame's snapshot. If
   * the previously-selected body has died (merged or removed), the panel
   * automatically resets.
   */
  refreshInspector(snap, fpp) {
    if (this.selectedId == null) return;
    let found = -1;
    for (let k = 0; k < snap.length; k += fpp) {
      if ((snap[k] | 0) === this.selectedId) { found = k; break; }
    }
    if (found < 0) { this.setSelected(null); return; }
    const mass   = snap[found + 2];
    const charge = snap[found + 3];
    const radius = snap[found + 4];
    const rx = snap[found + 5], ry = snap[found + 6], rz = snap[found + 7];
    const vx = snap[found + 8], vy = snap[found + 9], vz = snap[found + 10];
    const sx = snap[found + 11], sy = snap[found + 12], sz = snap[found + 13];
    const gamma = snap[found + 14];
    $('ins-mass').textContent    = formatExp(mass);
    $('ins-charge').textContent  = formatExp(charge);
    $('ins-radius').textContent  = formatExp(radius);
    $('ins-rmag').textContent    = formatExp(Math.hypot(rx, ry, rz));
    $('ins-vmag').textContent    = formatExp(Math.hypot(vx, vy, vz));
    $('ins-gamma').textContent   = gamma.toFixed(6);
    $('ins-spinmag').textContent = formatExp(Math.hypot(sx, sy, sz));
  }
}

function formatExp(v) {
  if (!isFinite(v)) return '\u221e';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e-3 && abs < 1e4) return v.toPrecision(4);
  return v.toExponential(3);
}
