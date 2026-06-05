//! Shared math kernel: the decision function + PRNG, used by BOTH the WASM
//! kernel (play.zig -> play.wasm, served + loadWasmMath + sim_batch) and the
//! native simulator (sim.zig). ONE source, two targets => the native sim
//! measures byte-identically what the WASM you ship produces. Pure functions,
//! no exports / no extern.

pub fn decide(r: f64) f64 {
    if (r < 0.30) return 0.5;
    if (r < 0.40) return 2.0;
    if (r < 0.41) return 50.0;
    return 0;
}

fn rotl(x: u64, comptime k: u6) u64 {
    return (x << k) | (x >> @as(u6, @intCast(@as(u32, 64) - @as(u32, k))));
}

/// xoshiro256++ seeded by splitmix64 (multiply-free output; fast + good).
pub const Xoshiro = struct {
    s: [4]u64 = .{ 0, 0, 0, 0 },

    pub fn seed(self: *Xoshiro, hi: u32, lo: u32) void {
        var st: u64 = (@as(u64, hi) << 32) | @as(u64, lo);
        var i: usize = 0;
        while (i < 4) : (i += 1) {
            st +%= 0x9e3779b97f4a7c15;
            var z = st;
            z = (z ^ (z >> 30)) *% 0xbf58476d1ce4e5b9;
            z = (z ^ (z >> 27)) *% 0x94d049bb133111eb;
            self.s[i] = z ^ (z >> 31);
        }
    }

    pub fn next(self: *Xoshiro) f64 {
        const result = rotl(self.s[0] +% self.s[3], 23) +% self.s[0];
        const t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = rotl(self.s[3], 45);
        return @as(f64, @floatFromInt(result >> 11)) / 9007199254740992.0;
    }
};

/// Streaming aggregate: enough to recover RTP, hit-rate, mean, stdDev, min, max.
pub const Stats = struct {
    count: f64 = 0,
    sum: f64 = 0,
    sumsq: f64 = 0,
    min: f64 = 1e308,
    max: f64 = 0,
    hits: f64 = 0,

    pub fn add(self: *Stats, m: f64) void {
        self.count += 1;
        self.sum += m;
        self.sumsq += m * m;
        if (m > self.max) self.max = m;
        if (m < self.min) self.min = m;
        if (m > 0) self.hits += 1;
    }
    pub fn merge(self: *Stats, o: Stats) void {
        self.count += o.count;
        self.sum += o.sum;
        self.sumsq += o.sumsq;
        if (o.max > self.max) self.max = o.max;
        if (o.min < self.min) self.min = o.min;
        self.hits += o.hits;
    }
};

/// Run `spins` plays from a fresh PRNG seeded by (hi,lo). The one place both
/// targets agree on, so per-slice output is identical native vs WASM.
pub fn runSlice(spins: u64, hi: u32, lo: u32) Stats {
    var rng = Xoshiro{};
    rng.seed(hi, lo);
    var st = Stats{};
    var i: u64 = 0;
    while (i < spins) : (i += 1) st.add(decide(rng.next()));
    return st;
}
