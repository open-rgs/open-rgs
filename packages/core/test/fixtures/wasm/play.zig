// Reference WASM math kernel: play (served + loadWasmMath) and sim_batch
// (in-WASM batch simulator). Both use the SHARED kernel.zig (decide + PRNG),
// which the native simulator (sim.zig) also uses => byte-parity native vs WASM.
// Build: zig build-exe play.zig -target wasm32-freestanding -fno-entry \
//        -rdynamic -OReleaseSmall -femit-bin=play.wasm

const kernel = @import("kernel.zig");

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

fn writeF64LE(out: [*]u8, at: usize, v: f64) void {
    const bits: u64 = @bitCast(v);
    var k: usize = 0;
    while (k < 8) : (k += 1) out[at + k] = @intCast((bits >> @as(u6, @intCast(k * 8))) & 0xff);
}

// N spins entirely in-WASM via the shared kernel; 6 little-endian f64 out.
export fn sim_batch(spins: u32, seed_hi: u32, seed_lo: u32, out_p: i32) void {
    const st = kernel.runSlice(@as(u64, spins), seed_hi, seed_lo);
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    writeF64LE(out, 0, st.count);
    writeF64LE(out, 8, st.sum);
    writeF64LE(out, 16, st.sumsq);
    writeF64LE(out, 24, if (st.count > 0) st.min else 0);
    writeF64LE(out, 32, st.max);
    writeF64LE(out, 40, st.hits);
}

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
    const mult = kernel.decide(rng_next());
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    var i: usize = 0;
    out[i] = 0x83; i += 1;                          // fixmap, 3 pairs
    i += writeStr(out, i, "multiplier"); out[i] = 0xcb; i += 1; writeF64BE(out, i, mult); i += 8;
    i += writeStr(out, i, "ops"); out[i] = 0x90; i += 1;
    i += writeStr(out, i, "type"); i += writeStr(out, i, if (mult > 0) "win" else "loss");
    return @intCast(i);
}
