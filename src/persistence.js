// Scene serialisation. Each save is a JSON blob with the SI-unit spawn specs
// for every alive particle, plus the renderer's visual gain so loading
// reproduces the look.
//
// Note: we deliberately do NOT serialise the history ring buffers. A loaded
// scene starts with empty histories, so the first crossing-time of retarded-
// field interactions will be slightly transient (sources before t=0 are
// treated as having been at rest at their initial positions). For a stable
// scene-load workflow this is acceptable; running for a few crossing times
// before saving usually erases the transient.

const VERSION = 1;

export function captureScene(bridge, gridGain = null) {
  const snap = bridge.snapshotView();
  const fpp = bridge.floatsPerParticle;
  const particles = [];
  for (let k = 0; k < snap.length; k += fpp) {
    particles.push({
      mass: snap[k + 2],
      charge: snap[k + 3],
      radius: snap[k + 4],
      r: [snap[k + 5], snap[k + 6], snap[k + 7]],
      v: [snap[k + 8], snap[k + 9], snap[k + 10]],
      spin: [snap[k + 11], snap[k + 12], snap[k + 13]],
      allow_merger: false, // not captured in snapshot; we use false as a safe default
    });
  }
  return {
    version: VERSION,
    saved_at: new Date().toISOString(),
    visual_gain: gridGain,
    particles,
  };
}

export function downloadJSON(obj, name = 'spacetime-scene.json') {
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}

export async function readSceneFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (typeof data.version !== 'number') throw new Error('not a spacetime-scene JSON');
  if (data.version > VERSION) throw new Error(`unsupported scene version ${data.version}`);
  if (!Array.isArray(data.particles)) throw new Error('missing particles[]');
  return data;
}

export function applyScene(bridge, scene) {
  bridge.clear();
  const failures = [];
  for (const p of scene.particles) {
    const res = bridge.spawn(p);
    if (!res.ok) failures.push({ p, err: res.error });
  }
  return failures;
}
