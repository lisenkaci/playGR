// The simulation driver. Owns all particles, orchestrates each substep, and
// exposes diagnostic readouts.
//
// All wasm-bindgen surface is in lib.rs; this module is plain Rust so it can
// be unit-tested with `cargo test`.

use crate::collisions;
use crate::constants::{C, G, WEAK_FIELD_LIMIT};
use crate::integrator;
use crate::particle::Particle;
use crate::physics::{newtonian_potential_at, total_fields_on, Fields};
use crate::vec3::Vec3;

pub struct World {
    pub particles: Vec<Particle>,
    pub t: f64,
    pub history_capacity: usize,
    pub next_id: u32,
    pub last_step_count: u32,
    pub mergers_total: u32,
    pub bounces_total: u32,
    #[allow(dead_code)]
    pub default_dt: f64,
    forces_prev: Vec<(Vec3, Fields)>,
}

#[derive(Copy, Clone, Debug)]
pub struct SpawnSpec {
    pub mass: f64,
    pub charge: f64,
    pub radius: f64,
    pub r: Vec3,
    pub v: Vec3,
    pub spin: Vec3,
    pub allow_merger: bool,
}

#[derive(Copy, Clone, Debug)]
pub enum SpawnError {
    NonPositiveMass,
    NonPositiveRadius,
    SuperluminalVelocity,
    WeakFieldExceeded,
    NonFiniteInput,
}

impl World {
    pub fn new(history_capacity: usize, default_dt: f64) -> Self {
        World {
            particles: Vec::new(),
            t: 0.0,
            history_capacity,
            next_id: 1,
            last_step_count: 0,
            mergers_total: 0,
            bounces_total: 0,
            default_dt,
            forces_prev: Vec::new(),
        }
    }

    pub fn spawn(&mut self, spec: SpawnSpec) -> Result<u32, SpawnError> {
        if !spec.r.is_finite()
            || !spec.v.is_finite()
            || !spec.spin.is_finite()
            || !spec.mass.is_finite()
            || !spec.charge.is_finite()
            || !spec.radius.is_finite()
        {
            return Err(SpawnError::NonFiniteInput);
        }
        if spec.mass <= 0.0 {
            return Err(SpawnError::NonPositiveMass);
        }
        if spec.radius <= 0.0 {
            return Err(SpawnError::NonPositiveRadius);
        }
        if spec.v.norm_sq() >= C * C {
            return Err(SpawnError::SuperluminalVelocity);
        }
        // Weak-field guard.
        let potential_ratio = G * spec.mass / (spec.radius * C * C);
        if potential_ratio >= WEAK_FIELD_LIMIT {
            return Err(SpawnError::WeakFieldExceeded);
        }

        let id = self.next_id;
        self.next_id += 1;
        let particle = Particle::new(
            id,
            spec.mass,
            spec.charge,
            spec.radius,
            spec.r,
            spec.v,
            spec.spin,
            spec.allow_merger,
            self.history_capacity,
            self.t,
        );
        self.particles.push(particle);
        self.forces_prev.push((Vec3::ZERO, Fields::default()));
        // Bootstrap forces on the new particle and on all others, so kick-A of
        // the next substep sees a correct F_n.
        let forces = integrator::compute_all_forces(&self.particles, self.t);
        self.forces_prev = forces;
        Ok(id)
    }

    pub fn remove(&mut self, id: u32) -> bool {
        if let Some((i, _)) = self
            .particles
            .iter()
            .enumerate()
            .find(|(_, p)| p.id == id && p.alive)
        {
            self.particles[i].alive = false;
            true
        } else {
            false
        }
    }

    /// Teleport a particle to (r, v). Forces are re-seeded so the next
    /// substep's kick sees a consistent state.
    pub fn teleport(&mut self, id: u32, r: Vec3, v: Vec3) -> bool {
        let mut found = false;
        let t = self.t;
        for p in self.particles.iter_mut() {
            if p.id == id && p.alive {
                p.teleport(r, v, t);
                found = true;
                break;
            }
        }
        if found {
            let forces = crate::integrator::compute_all_forces(&self.particles, self.t);
            self.forces_prev = forces;
        }
        found
    }

    pub fn clear(&mut self) {
        self.particles.clear();
        self.forces_prev.clear();
        self.t = 0.0;
        self.last_step_count = 0;
        self.mergers_total = 0;
        self.bounces_total = 0;
    }

    /// Advance the simulation by `dt_total` physics seconds, in adaptive
    /// substeps no larger than `dt_max`.
    pub fn advance(&mut self, dt_total: f64, dt_max: f64) {
        if dt_total <= 0.0 || !dt_total.is_finite() {
            return;
        }
        let mut remaining = dt_total;
        let mut count = 0u32;
        let max_steps = 4096u32; // hard ceiling to keep one frame finite

        while remaining > 0.0 && count < max_steps {
            // Recommend a stable substep size from local conditions.
            let dt_rec = integrator::recommend_dt(&self.particles, &self.forces_prev, dt_max);
            let dt = dt_rec.min(remaining).min(dt_max).max(1.0e-15);

            integrator::step(&mut self.particles, &mut self.forces_prev, self.t, dt);
            self.t += dt;
            remaining -= dt;
            count += 1;

            // Resolve any hard-sphere overlaps before next substep.
            let stats = collisions::resolve(&mut self.particles);
            self.bounces_total += stats.bounces;
            self.mergers_total += stats.mergers;
            if stats.mergers > 0 {
                // After a merger we need to re-seed forces because one
                // particle's mass changed and another died.
                let forces = integrator::compute_all_forces(&self.particles, self.t);
                self.forces_prev = forces;
            }
        }
        self.last_step_count = count;
    }

    pub fn alive_count(&self) -> usize {
        self.particles.iter().filter(|p| p.alive).count()
    }

    pub fn total_energy(&self) -> f64 {
        self.particles
            .iter()
            .filter(|p| p.alive)
            .map(|p| p.energy())
            .sum()
    }

    pub fn total_momentum(&self) -> Vec3 {
        self.particles
            .iter()
            .filter(|p| p.alive)
            .fold(Vec3::ZERO, |acc, p| acc + p.p)
    }

    pub fn max_gamma(&self) -> f64 {
        self.particles
            .iter()
            .filter(|p| p.alive)
            .map(|p| p.gamma())
            .fold(1.0_f64, f64::max)
    }

    pub fn max_bg(&self) -> f64 {
        let mut best = 0.0_f64;
        for (i, p) in self.particles.iter().enumerate() {
            if !p.alive {
                continue;
            }
            let f = total_fields_on(&self.particles, i, self.t);
            best = best.max(f.bg.norm());
        }
        best
    }

    pub fn newtonian_potential(&self, probe: Vec3) -> f64 {
        newtonian_potential_at(&self.particles, probe)
    }
}
