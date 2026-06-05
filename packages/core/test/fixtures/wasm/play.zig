// Reference WASM math kernel for loadWasmMath (open-rgs core).
// Implements the spec ABI (specs/03-math-runtime.md "WASM runtime details").
// Simple math: hello-spin distribution. Outcome is msgpack-encoded into out_p.
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
    const r = rng_next();
    var mult: f64 = 0;
    if (r < 0.30) { mult = 0.5; } else if (r < 0.40) { mult = 2.0; } else if (r < 0.41) { mult = 50.0; }
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    var i: usize = 0;
    out[i] = 0x83; i += 1;                          // fixmap, 3 pairs
    i += writeStr(out, i, "multiplier"); out[i] = 0xcb; i += 1; writeF64BE(out, i, mult); i += 8;
    i += writeStr(out, i, "ops"); out[i] = 0x90; i += 1;          // empty array
    i += writeStr(out, i, "type"); i += writeStr(out, i, if (mult > 0) "win" else "loss");
    return @intCast(i);
}
