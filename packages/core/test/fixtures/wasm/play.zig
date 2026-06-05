// Reference WASM math kernel for loadWasmMath + the in-WASM batch simulator.
// Implements the spec ABI (specs/03-math-runtime.md "WASM runtime details").
// Simple math: hello-spin distribution.
//
// Two entry points share ONE decision function (`decide`), so the batch
// simulator measures byte-identically what `play` produces in production:
//   - play(...)      : one spin, draws from the host CSPRNG import, msgpack out.
//   - sim_batch(...) : N spins entirely in-WASM (seeded in-VM xoshiro256++),
//                      returning aggregate stats  - no per-spin JS boundary.
//
// Build: zig build-exe play.zig -target wasm32-freestanding -fno-entry \
//        -rdynamic -OReleaseSmall -femit-bin=play.wasm

extern "host" fn rng_next() f64;

const NAME: []const u8 = "wasm-demo";
const VERSION: []const u8 = "1.0.0";

var heap: [131072]u8 = undefined;
var heap_top: usize = 0;

export fn kind() i32 { return 0; } // 0 = simple
export fn name_ptr() i32 { return @intCast(@intFromPtr(NAME.ptr)); }
export fn name_len() i32 { return @intCast(NAME.len); }
export fn version_ptr() i32 { return @intCast(@intFromPtr(VERSION.ptr)); }
export fn version_len() i32 { return @intCast(VERSION.len); }
export fn rtp_x10000() i32 { return 8500; } // 0.85

export fn reset() void { heap_top = 0; }
export fn alloc(n: i32) i32 {
    const start = heap_top;
    heap_top += @as(usize, @intCast(n));
    return @intCast(@intFromPtr(&heap[start]));
}
export fn free(p: i32) void { _ = p; }

// --- shared math decision (the ONLY place the distribution lives) -----------
fn decide(r: f64) f64 {
    if (r < 0.30) return 0.5;
    if (r < 0.40) return 2.0;
    if (r < 0.41) return 50.0;
    return 0;
}

// --- in-WASM PRNG for sim_batch: xoshiro256++ seeded by splitmix64 ----------
var xs: [4]u64 = .{ 0, 0, 0, 0 };
var sm_state: u64 = 0;
fn rotl(x: u64, comptime k: u6) u64 {
    return (x << k) | (x >> @as(u6, @intCast(@as(u32, 64) - @as(u32, k))));
}
fn splitmix() u64 {
    sm_state +%= 0x9e3779b97f4a7c15;
    var z = sm_state;
    z = (z ^ (z >> 30)) *% 0xbf58476d1ce4e5b9;
    z = (z ^ (z >> 27)) *% 0x94d049bb133111eb;
    return z ^ (z >> 31);
}
fn prng_reseed(hi: u32, lo: u32) void {
    sm_state = (@as(u64, hi) << 32) | @as(u64, lo);
    xs[0] = splitmix(); xs[1] = splitmix(); xs[2] = splitmix(); xs[3] = splitmix();
}
fn prng_next() f64 {
    const result = rotl(xs[0] +% xs[3], 23) +% xs[0]; // xoshiro256++ output
    const t = xs[1] << 17;
    xs[2] ^= xs[0]; xs[3] ^= xs[1]; xs[1] ^= xs[2]; xs[0] ^= xs[3]; xs[2] ^= t; xs[3] = rotl(xs[3], 45);
    return @as(f64, @floatFromInt(result >> 11)) / 9007199254740992.0;
}

fn writeF64LE(out: [*]u8, at: usize, v: f64) void {
    const bits: u64 = @bitCast(v);
    var k: usize = 0;
    while (k < 8) : (k += 1) out[at + k] = @intCast((bits >> @as(u6, @intCast(k * 8))) & 0xff);
}

/// Run `spins` plays entirely in-WASM (seeded in-VM PRNG) and write aggregate
/// stats to out_p as 6 little-endian f64: [count, sum, sumsq, min, max, hits].
/// `count` lets the host merge chunks exactly; RTP = sum/count, hitRate =
/// hits/count, variance = sumsq/count - (sum/count)^2.
export fn sim_batch(spins: u32, seed_hi: u32, seed_lo: u32, out_p: i32) void {
    prng_reseed(seed_hi, seed_lo);
    var count: f64 = 0;
    var sum: f64 = 0;
    var sumsq: f64 = 0;
    var mn: f64 = 1e308;
    var mx: f64 = 0;
    var hits: f64 = 0;
    var i: u32 = 0;
    while (i < spins) : (i += 1) {
        const m = decide(prng_next());
        count += 1;
        sum += m;
        sumsq += m * m;
        if (m > mx) mx = m;
        if (m < mn) mn = m;
        if (m > 0) hits += 1;
    }
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    writeF64LE(out, 0, count);
    writeF64LE(out, 8, sum);
    writeF64LE(out, 16, sumsq);
    writeF64LE(out, 24, if (count > 0) mn else 0);
    writeF64LE(out, 32, mx);
    writeF64LE(out, 40, hits);
}

// --- single-spin play (production path): host CSPRNG draw, msgpack outcome --
fn writeStr(out: [*]u8, at: usize, s: []const u8) usize {
    out[at] = 0xa0 | @as(u8, @intCast(s.len)); // fixstr (len < 32)
    var j: usize = 0;
    while (j < s.len) : (j += 1) out[at + 1 + j] = s[j];
    return 1 + s.len;
}
fn writeF64BE(out: [*]u8, at: usize, v: f64) void {
    const bits: u64 = @bitCast(v);
    var k: usize = 0;
    while (k < 8) : (k += 1) out[at + k] = @intCast((bits >> @as(u6, @intCast((7 - k) * 8))) & 0xff);
}

export fn play(prev_p: i32, prev_l: i32, ctx_p: i32, ctx_l: i32, out_p: i32, out_max: i32) i32 {
    _ = prev_p; _ = prev_l; _ = ctx_p; _ = ctx_l; _ = out_max;
    const mult = decide(rng_next());
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    var i: usize = 0;
    out[i] = 0x83; i += 1;                          // fixmap, 3 pairs
    i += writeStr(out, i, "multiplier"); out[i] = 0xcb; i += 1; writeF64BE(out, i, mult); i += 8;
    i += writeStr(out, i, "ops"); out[i] = 0x90; i += 1;          // empty array
    i += writeStr(out, i, "type"); i += writeStr(out, i, if (mult > 0) "win" else "loss");
    return @intCast(i);
}
