// twin-slot: a minimal SIMPLE-round slot in Zig - the WASM twin of slot.lua.
//
// This is one half of a matched pair. maths/slot.lua is the EXACT same game in
// Lua; test/twin-slot.test.ts proves they return byte-identical outcomes for
// the same RNG stream. The point of the pair is to show that a math written in
// either runtime is interchangeable to the engine, and to give you a side-by-
// side template when porting Lua math to a fast WASM kernel (or vice versa).
//
// The game: one RNG draw -> a paytable. EV (RTP) = 0.96:
//     0.02*20 + 0.04*5 + 0.36*1 = 0.40 + 0.20 + 0.36 = 0.96
// Keep `decide()` here and the `if/elseif` ladder in slot.lua in lock-step -
// same thresholds, same payouts, same RNG-draw count (exactly one) - or the
// parity test fails. That test is the contract between the two files.
//
// I/O is MessagePack over linear memory (the ABI loadWasmMath speaks). A simple
// kernel needs just `play`; everything else here (kind/name/version/rtp/alloc/
// reset) is boilerplate the loader calls. `sim_batch` is an in-WASM self-play
// loop for native-speed RTP measurement (used by the test and src/compare.ts).
//
// Build (committed as slot.wasm; CI uses the committed artifact, no zig needed):
//   zig build-exe slot.zig -target wasm32-freestanding -fno-entry -rdynamic \
//     -OReleaseSmall -femit-bin=slot.wasm

extern "host" fn rng_next() f64;

const NAME: []const u8 = "twin-slot";
const VERSION: []const u8 = "1.0.0";

var heap: [131072]u8 = undefined;
var heap_top: usize = 0;

export fn kind() i32 {
    return 0; // 0 = simple
}
export fn name_ptr() i32 {
    return @intCast(@intFromPtr(NAME.ptr));
}
export fn name_len() i32 {
    return @intCast(NAME.len);
}
export fn version_ptr() i32 {
    return @intCast(@intFromPtr(VERSION.ptr));
}
export fn version_len() i32 {
    return @intCast(VERSION.len);
}
export fn rtp_x10000() i32 {
    return 9600; // 0.96
}

export fn reset() void {
    heap_top = 0;
}
export fn alloc(n: i32) i32 {
    const start = heap_top;
    heap_top += @as(usize, @intCast(n));
    return @intCast(@intFromPtr(&heap[start]));
}
export fn free(p: i32) void {
    _ = p;
}

// The paytable. MUST mirror slot.lua's play() exactly (thresholds + payouts).
fn decide(r: f64) f64 {
    if (r < 0.02) return 20.0;
    if (r < 0.06) return 5.0;
    if (r < 0.42) return 1.0;
    return 0.0;
}

// --- minimal MessagePack writers ----------------------------------------
fn wStr(out: [*]u8, at: usize, s: []const u8) usize {
    out[at] = 0xa0 | @as(u8, @intCast(s.len)); // fixstr (len < 32)
    var j: usize = 0;
    while (j < s.len) : (j += 1) out[at + 1 + j] = s[j];
    return 1 + s.len;
}
fn wF64(out: [*]u8, at: usize, v: f64) usize {
    out[at] = 0xcb; // float64
    const bits: u64 = @bitCast(v);
    var k: usize = 0;
    while (k < 8) : (k += 1) out[at + 1 + k] = @intCast((bits >> @as(u6, @intCast((7 - k) * 8))) & 0xff);
    return 9;
}

// play outcome: { multiplier, ops: [{ kind: "spin", mult }], type }
export fn play(prev_p: i32, prev_l: i32, ctx_p: i32, ctx_l: i32, out_p: i32, out_max: i32) i32 {
    _ = prev_p;
    _ = prev_l;
    _ = ctx_p;
    _ = ctx_l;
    _ = out_max;
    const mult = decide(rng_next());
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    var i: usize = 0;
    out[i] = 0x83; // fixmap, 3 pairs
    i += 1;
    i += wStr(out, i, "multiplier");
    i += wF64(out, i, mult);
    i += wStr(out, i, "ops");
    out[i] = 0x91; // fixarray, 1 element
    i += 1;
    out[i] = 0x82; // fixmap, 2 pairs
    i += 1;
    i += wStr(out, i, "kind");
    i += wStr(out, i, "spin");
    i += wStr(out, i, "mult");
    i += wF64(out, i, mult);
    i += wStr(out, i, "type");
    i += wStr(out, i, if (mult > 0) "win" else "loss");
    return @intCast(i);
}

// --- in-WASM self-play for exact, native-speed RTP ----------------------
// Same decide() the served play() uses, so the measured RTP is the real one.
fn rotl(x: u64, comptime k: u6) u64 {
    return (x << k) | (x >> @as(u6, @intCast(@as(u32, 64) - @as(u32, k))));
}
const Xoshiro = struct {
    s: [4]u64 = .{ 0, 0, 0, 0 },
    fn seed(self: *Xoshiro, hi: u32, lo: u32) void {
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
    fn next(self: *Xoshiro) f64 {
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

fn writeF64LE(out: [*]u8, at: usize, v: f64) void {
    const bits: u64 = @bitCast(v);
    var k: usize = 0;
    while (k < 8) : (k += 1) out[at + k] = @intCast((bits >> @as(u6, @intCast(k * 8))) & 0xff);
}

// N spins entirely in-WASM; writes 6 little-endian f64 (count, sum, sumsq, min,
// max, hits) - the shape reportFromAggregate / the test consume.
export fn sim_batch(spins: u32, seed_hi: u32, seed_lo: u32, out_p: i32) void {
    var rng = Xoshiro{};
    rng.seed(seed_hi, seed_lo);
    var count: f64 = 0;
    var sum: f64 = 0;
    var sumsq: f64 = 0;
    var mn: f64 = 1e308;
    var mx: f64 = 0;
    var hits: f64 = 0;
    var i: u32 = 0;
    while (i < spins) : (i += 1) {
        const ret = decide(rng.next());
        count += 1;
        sum += ret;
        sumsq += ret * ret;
        if (ret > mx) mx = ret;
        if (ret < mn) mn = ret;
        if (ret > 0) hits += 1;
    }
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    writeF64LE(out, 0, count);
    writeF64LE(out, 8, sum);
    writeF64LE(out, 16, sumsq);
    writeF64LE(out, 24, if (count > 0) mn else 0);
    writeF64LE(out, 32, mx);
    writeF64LE(out, 40, hits);
}
