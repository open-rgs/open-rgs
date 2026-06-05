// WASM wrapper for the generic hold-&-win kernel.
//   play(...)      -> one round drawing from the injected host CSPRNG; msgpack
//                     { multiplier, ops:[], type } out (loadWasmMath).
//   sim_batch(...) -> N rounds via the seeded in-VM PRNG; 6-f64 aggregate out.
// Build: zig build-exe play.zig -target wasm32-freestanding -fno-entry \
//        -rdynamic -OReleaseSmall -femit-bin=play.wasm
const kernel = @import("kernel.zig");

extern "host" fn rng_next() f64;
const HostRng = struct {
    pub fn next(_: *HostRng) f64 { return rng_next(); }
};

const NAME: []const u8 = "hold-and-win";
const VERSION: []const u8 = "1.0.0";
var heap: [131072]u8 = undefined;
var heap_top: usize = 0;

export fn kind() i32 { return 0; } // simple (single play call)
export fn name_ptr() i32 { return @intCast(@intFromPtr(NAME.ptr)); }
export fn name_len() i32 { return @intCast(NAME.len); }
export fn version_ptr() i32 { return @intCast(@intFromPtr(VERSION.ptr)); }
export fn version_len() i32 { return @intCast(VERSION.len); }
export fn rtp_x10000() i32 { return 9592; } // declared 95.92% (long-run measured)

export fn reset() void { heap_top = 0; }
export fn alloc(n: i32) i32 { const s = heap_top; heap_top += @as(usize, @intCast(n)); return @intCast(@intFromPtr(&heap[s])); }
export fn free(p: i32) void { _ = p; }

fn writeF64LE(out: [*]u8, at: usize, v: f64) void { const bits: u64 = @bitCast(v); var k: usize = 0; while (k < 8) : (k += 1) out[at + k] = @intCast((bits >> @as(u6, @intCast(k * 8))) & 0xff); }

export fn sim_batch(spins: u32, seed_hi: u32, seed_lo: u32, out_p: i32) void {
    const st = kernel.runSlice(@as(u64, spins), seed_hi, seed_lo);
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    writeF64LE(out, 0, st.count);
    writeF64LE(out, 8, st.sum);
    writeF64LE(out, 16, st.sumsq);
    writeF64LE(out, 24, 0); // min (a losing spin pays 0)
    writeF64LE(out, 32, st.max);
    writeF64LE(out, 40, st.hits);
}

fn writeStr(out: [*]u8, at: usize, s: []const u8) usize { out[at] = 0xa0 | @as(u8, @intCast(s.len)); var j: usize = 0; while (j < s.len) : (j += 1) out[at + 1 + j] = s[j]; return 1 + s.len; }
fn writeF64BE(out: [*]u8, at: usize, v: f64) void { const bits: u64 = @bitCast(v); var k: usize = 0; while (k < 8) : (k += 1) out[at + k] = @intCast((bits >> @as(u6, @intCast((7 - k) * 8))) & 0xff); }

export fn play(prev_p: i32, prev_l: i32, ctx_p: i32, ctx_l: i32, out_p: i32, out_max: i32) i32 {
    _ = prev_p; _ = prev_l; _ = ctx_p; _ = ctx_l; _ = out_max;
    var host = HostRng{};
    const r = kernel.playRound(&host); // draws from the injected host CSPRNG
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    var i: usize = 0;
    out[i] = 0x83; i += 1;
    i += writeStr(out, i, "multiplier"); out[i] = 0xcb; i += 1; writeF64BE(out, i, r.mult); i += 8;
    i += writeStr(out, i, "ops"); out[i] = 0x90; i += 1;
    i += writeStr(out, i, "type"); i += writeStr(out, i, if (r.feature) "feature" else if (r.mult > 0) "win" else "loss");
    return @intCast(i);
}
