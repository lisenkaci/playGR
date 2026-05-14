// Fixed-capacity ring buffer used to store historical particle states for
// retarded-potential lookups. The buffer never allocates after construction.
//
// Time ordering: entries are pushed in increasing-time order. The newest entry
// is at `head - 1` (mod cap); the oldest currently stored entry is at `tail`.
// Once the buffer is full, every push overwrites the oldest entry.

use crate::particle::State;

#[derive(Debug)]
pub struct RingBuffer {
    buf: Vec<State>,
    cap: usize,
    head: usize, // next write index
    len: usize,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity >= 2, "ring buffer needs at least 2 slots for lerp");
        RingBuffer {
            buf: vec![State::default(); capacity],
            cap: capacity,
            head: 0,
            len: 0,
        }
    }

    #[allow(dead_code)]
    #[inline]
    pub fn capacity(&self) -> usize {
        self.cap
    }
    #[allow(dead_code)]
    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }
    #[allow(dead_code)]
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub fn push(&mut self, s: State) {
        self.buf[self.head] = s;
        self.head = (self.head + 1) % self.cap;
        if self.len < self.cap {
            self.len += 1;
        }
    }

    /// Discard every stored entry. Used when a particle is teleported, so
    /// retarded-time lookups from other particles don't see a long ghost
    /// trail at the pre-teleport position.
    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }

    #[inline]
    pub fn newest(&self) -> Option<&State> {
        if self.len == 0 {
            return None;
        }
        let i = (self.head + self.cap - 1) % self.cap;
        Some(&self.buf[i])
    }

    #[inline]
    pub fn oldest(&self) -> Option<&State> {
        if self.len == 0 {
            return None;
        }
        let i = (self.head + self.cap - self.len) % self.cap;
        Some(&self.buf[i])
    }

    /// Index in time order: 0 = oldest, len-1 = newest.
    #[inline]
    pub fn get(&self, age_index: usize) -> Option<&State> {
        if age_index >= self.len {
            return None;
        }
        let oldest = (self.head + self.cap - self.len) % self.cap;
        let i = (oldest + age_index) % self.cap;
        Some(&self.buf[i])
    }

    /// Look up the state at a given absolute time `t`, interpolating linearly
    /// between the two surrounding stored frames. Returns the newest state if
    /// `t` is past the most recent frame, the oldest state if `t` predates the
    /// buffer, or `None` if the buffer is empty.
    pub fn sample_at(&self, t: f64) -> Option<State> {
        if self.len == 0 {
            return None;
        }
        if self.len == 1 {
            return self.newest().copied();
        }

        let oldest_t = self.oldest().unwrap().t;
        let newest_t = self.newest().unwrap().t;

        if t <= oldest_t {
            return self.oldest().copied();
        }
        if t >= newest_t {
            return self.newest().copied();
        }

        // Binary search the age index for `t`. Frames are stored in strictly
        // increasing time order, so a binary search by age works.
        let mut lo = 0usize;
        let mut hi = self.len - 1;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            let tm = self.get(mid).unwrap().t;
            if tm <= t {
                lo = mid;
            } else {
                hi = mid;
            }
        }

        let a = self.get(lo).unwrap();
        let b = self.get(hi).unwrap();
        let dt = b.t - a.t;
        let alpha = if dt > 0.0 { (t - a.t) / dt } else { 0.0 };
        Some(State::lerp(a, b, alpha))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particle::State;
    use crate::vec3::Vec3;

    fn s_at(t: f64, x: f64) -> State {
        State {
            t,
            r: Vec3::new(x, 0.0, 0.0),
            v: Vec3::ZERO,
            a: Vec3::ZERO,
        }
    }

    #[test]
    fn fills_and_wraps() {
        let mut rb = RingBuffer::new(4);
        rb.push(s_at(0.0, 0.0));
        rb.push(s_at(1.0, 1.0));
        rb.push(s_at(2.0, 2.0));
        rb.push(s_at(3.0, 3.0));
        rb.push(s_at(4.0, 4.0));
        assert_eq!(rb.len(), 4);
        assert_eq!(rb.oldest().unwrap().t, 1.0);
        assert_eq!(rb.newest().unwrap().t, 4.0);
    }

    #[test]
    fn lerp_between_frames() {
        let mut rb = RingBuffer::new(8);
        for i in 0..5 {
            rb.push(s_at(i as f64, i as f64 * 10.0));
        }
        let s = rb.sample_at(2.5).unwrap();
        assert!((s.r.x - 25.0).abs() < 1e-12, "lerp gave {}", s.r.x);
    }

    #[test]
    fn before_oldest_returns_oldest() {
        let mut rb = RingBuffer::new(4);
        rb.push(s_at(10.0, 100.0));
        rb.push(s_at(11.0, 110.0));
        let s = rb.sample_at(0.0).unwrap();
        assert_eq!(s.r.x, 100.0);
    }

    #[test]
    fn after_newest_returns_newest() {
        let mut rb = RingBuffer::new(4);
        rb.push(s_at(10.0, 100.0));
        rb.push(s_at(11.0, 110.0));
        let s = rb.sample_at(99.0).unwrap();
        assert_eq!(s.r.x, 110.0);
    }
}
