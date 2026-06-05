//! Generic hold-&-win math, in Zig. Invented numbers - NOT any specific game.
//! 3x3 grid; coins land in the base; TRIGGER+ coins start the feature; 3
//! respins that RESET to 3 whenever a new coin lands; fill the whole grid for
//! the grand. Shared by play.zig (-> WASM: play + sim_batch) and sim.zig
//! (native simulator), so the native sim is byte-identical to the WASM.
//!
//! `playRound` is generic over the RNG (`anytype` with `.next() f64`): the
//! served `play` feeds it the host CSPRNG; `sim_batch`/native feed it a seeded
//! in-VM xoshiro. Same decision logic either way.

fn rotl(x: u64, comptime k: u6) u64 {
    return (x << k) | (x >> @as(u6, @intCast(@as(u32, 64) - @as(u32, k))));
}

/// xoshiro256++ seeded by splitmix64 (used by the sim; the served `play` uses
/// the host CSPRNG instead).
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
        self.s[2] ^= self.s[0]; self.s[3] ^= self.s[1]; self.s[1] ^= self.s[2]; self.s[0] ^= self.s[3]; self.s[2] ^= t; self.s[3] = rotl(self.s[3], 45);
        return @as(f64, @floatFromInt(result >> 11)) / 9007199254740992.0;
    }
};

// --- Game parameters (invented; tuned so RTP ~= 96%) ------------------------
pub const CELLS: u32 = 9; // 3x3
pub const TRIGGER: u32 = 6; // coins needed to start the feature
pub const GRAND: f64 = 1000.0; // grand jackpot (grid fill), x bet
pub const MAXWIN: f64 = 5000.0; // max-win cap, x bet
// `var` so the native sim can sweep them via CLI; play.wasm bakes these
// defaults (nothing sets them at runtime in the served path).
pub var P_COIN: f64 = 0.25;   // base-game coin probability per cell (tuned -> RTP ~96%)
pub var P_RESPIN: f64 = 0.031; // respin coin probability per empty cell (tuned)

fn coinValue(rng: anytype) f64 {
    const r = rng.next();
    if (r < 0.70) return 1;
    if (r < 0.90) return 2;
    if (r < 0.97) return 5;
    if (r < 0.995) return 10;
    if (r < 0.999) return 25; // minor
    if (r < 0.9999) return 100; // major
    return 500;
}
fn baseWin(rng: anytype) f64 {
    const r = rng.next();
    if (r < 0.70) return 0;
    if (r < 0.95) return 0.5 + rng.next() * 2.5; // 25%: 0.5..3
    return 3.0 + rng.next() * 7.0; // 5%: 3..10
}

pub const Round = struct { mult: f64, feature: bool, grand: bool };

/// One full spin. `rng` is anything with `.next() f64`.
pub fn playRound(rng: anytype) Round {
    var nCoins: u32 = 0;
    var coinSum: f64 = 0;
    var cell: u32 = 0;
    while (cell < CELLS) : (cell += 1) {
        if (rng.next() < P_COIN) { nCoins += 1; coinSum += coinValue(rng); }
    }
    if (nCoins < TRIGGER) return .{ .mult = baseWin(rng), .feature = false, .grand = false };

    var respins: u32 = 3;
    while (respins > 0 and nCoins < CELLS) {
        const empty = CELLS - nCoins;
        var newc: u32 = 0;
        var e: u32 = 0;
        while (e < empty) : (e += 1) {
            if (rng.next() < P_RESPIN) { newc += 1; coinSum += coinValue(rng); }
        }
        nCoins += newc;
        if (newc > 0) { respins = 3; } else { respins -= 1; }
    }
    var grand = false;
    var win = coinSum;
    if (nCoins >= CELLS) { grand = true; win += GRAND; }
    if (win > MAXWIN) win = MAXWIN;
    return .{ .mult = win, .feature = true, .grand = grand };
}

pub const Stats = struct {
    count: f64 = 0, sum: f64 = 0, sumsq: f64 = 0, max: f64 = 0, hits: f64 = 0, feat: f64 = 0, grand: f64 = 0,
    pub fn add(self: *Stats, r: Round) void {
        self.count += 1; self.sum += r.mult; self.sumsq += r.mult * r.mult;
        if (r.mult > self.max) self.max = r.mult;
        if (r.mult > 0) self.hits += 1;
        if (r.feature) self.feat += 1;
        if (r.grand) self.grand += 1;
    }
    pub fn merge(self: *Stats, o: Stats) void {
        self.count += o.count; self.sum += o.sum; self.sumsq += o.sumsq;
        if (o.max > self.max) self.max = o.max;
        self.hits += o.hits; self.feat += o.feat; self.grand += o.grand;
    }
};
pub fn runSlice(spins: u64, hi: u32, lo: u32) Stats {
    var rng = Xoshiro{}; rng.seed(hi, lo);
    var st = Stats{};
    var i: u64 = 0;
    while (i < spins) : (i += 1) st.add(playRound(&rng));
    return st;
}
