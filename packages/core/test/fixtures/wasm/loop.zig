// Runaway WASM math fixture: play() never returns. Loads fine (metadata is
// valid) so the worker pool can start it; calling play() spins forever, which
// the pool must terminate-on-timeout. Build:
//   zig build-exe loop.zig -target wasm32-freestanding -fno-entry -rdynamic \
//     -OReleaseSmall -femit-bin=loop.wasm
const NAME: []const u8 = "loop-forever";
const VERSION: []const u8 = "1.0.0";
var heap: [4096]u8 = undefined;
var heap_top: usize = 0;
export fn kind() i32 { return 0; }
export fn name_ptr() i32 { return @intCast(@intFromPtr(NAME.ptr)); }
export fn name_len() i32 { return @intCast(NAME.len); }
export fn version_ptr() i32 { return @intCast(@intFromPtr(VERSION.ptr)); }
export fn version_len() i32 { return @intCast(VERSION.len); }
export fn rtp_x10000() i32 { return 0; }
export fn reset() void { heap_top = 0; }
export fn alloc(n: i32) i32 { const s = heap_top; heap_top += @as(usize, @intCast(n)); return @intCast(@intFromPtr(&heap[s])); }
export fn free(p: i32) void { _ = p; }
export fn play(prev_p: i32, prev_l: i32, ctx_p: i32, ctx_l: i32, out_p: i32, out_max: i32) i32 {
    _ = prev_p; _ = prev_l; _ = ctx_p; _ = ctx_l; _ = out_p; _ = out_max;
    while (true) {}
}
