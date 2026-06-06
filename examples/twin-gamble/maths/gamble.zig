// twin-gamble: a minimal COMPLEX-round game in Zig - the WASM twin of gamble.lua.
//
// One half of a matched pair. maths/gamble.lua is the EXACT same game in Lua;
// test/twin-gamble.test.ts drives a full open -> step* -> close lifecycle through
// BOTH and asserts identical observable outcomes for the same RNG stream. Use it
// as the template for "how a complex round works" in either runtime.
//
// THE MECHANIC - fair double-or-nothing:
//   open()  deals a base win from a paytable (EV 0.96) and, if it's > 0, awaits.
//   step()  is one FAIR gamble: heads (p=0.5) doubles the win, tails busts to 0.
//   close() pays the current win. To COLLECT, the player just closes instead of
//           stepping again (collect = the closeRound request, not an action) -
//           so step() never has to decode the action payload, which keeps the
//           Zig and Lua kernels trivially identical.
//
// WHY IT'S INTERESTING: a fair gamble is EV-neutral, so the round's RTP equals
// the base slot's (~0.96) under ANY gamble policy - gambling moves variance, not
// edge. The in-WASM sim_gamble() self-play proves it (RTP flat across stop@N).
// (Contrast examples/cash-ladder, whose climb is UNFAIR and erodes RTP.)
//
// COMPLEX-ROUND KEY IDEA: the kernel keeps NOTHING between calls. Core stores the
// round's `state` (an opaque string) and threads it back into step/is_terminal/
// close. So every call (de)serializes the FULL state. Here that state is an
// opaque 8-byte blob emitted as a MessagePack `bin`; the host (loadWasmMath)
// base64s it into the contract RoundState string - the kernel never sees base64,
// core never sees bytes.
//
// Build (committed as gamble.wasm; CI uses the committed artifact, no zig):
//   zig build-exe gamble.zig -target wasm32-freestanding -fno-entry -rdynamic \
//     -OReleaseSmall -femit-bin=gamble.wasm

extern "host" fn rng_next() f64;

const NAME: []const u8 = "twin-gamble";
const VERSION: []const u8 = "1.0.0";

const MAX_GAMBLES: u32 = 8; // 2^8 = 256x the base win, max
const P_WIN: f64 = 0.5; // FAIR double-or-nothing (EV-neutral)

var heap: [131072]u8 = undefined;
var heap_top: usize = 0;

export fn kind() i32 {
    return 1; // 1 = complex
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
    return 9600; // 0.96 (policy-invariant: the gamble is fair)
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

// Base paytable. MUST mirror gamble.lua's baseWin() exactly. EV = 0.96:
//   0.18*2 + 0.60*1 = 0.36 + 0.60 = 0.96
fn baseWin(r: f64) u32 {
    if (r < 0.18) return 2;
    if (r < 0.78) return 1;
    return 0;
}

// --- the kernel's own opaque state layout (8 bytes) ---------------------
const State = struct {
    gambles: u32, // how many successful doubles so far (<= MAX_GAMBLES)
    done: u8, // 1 = terminal (busted, collected, or capped)
    win: u32, // current win multiplier (0 = busted / losing spin)

    fn read(p: [*]const u8) State {
        return .{
            .gambles = p[0],
            .done = p[1],
            .win = @as(u32, p[4]) | (@as(u32, p[5]) << 8) |
                (@as(u32, p[6]) << 16) | (@as(u32, p[7]) << 24),
        };
    }
    fn write(self: State, p: [*]u8) void {
        p[0] = @intCast(self.gambles & 0xff);
        p[1] = self.done;
        p[2] = 0;
        p[3] = 0;
        p[4] = @intCast(self.win & 0xff);
        p[5] = @intCast((self.win >> 8) & 0xff);
        p[6] = @intCast((self.win >> 16) & 0xff);
        p[7] = @intCast((self.win >> 24) & 0xff);
    }
};

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
fn wU32(out: [*]u8, at: usize, v: u32) usize {
    out[at] = 0xce; // uint32
    out[at + 1] = @intCast((v >> 24) & 0xff);
    out[at + 2] = @intCast((v >> 16) & 0xff);
    out[at + 3] = @intCast((v >> 8) & 0xff);
    out[at + 4] = @intCast(v & 0xff);
    return 5;
}
fn wBin8(out: [*]u8, at: usize, bytes: []const u8) usize {
    out[at] = 0xc4; // bin8
    out[at + 1] = @intCast(bytes.len);
    var j: usize = 0;
    while (j < bytes.len) : (j += 1) out[at + 2 + j] = bytes[j];
    return 2 + bytes.len;
}

// open/step outcome: { state: bin, ops: [{event, win}], awaiting?: {type:"gamble"} }
fn encodeProgress(out: [*]u8, s: State, event: []const u8) usize {
    const terminal = s.done == 1;
    var sb: [8]u8 = undefined;
    s.write(&sb);
    var i: usize = 0;
    const pairs: u8 = if (terminal) 2 else 3;
    out[i] = 0x80 | pairs; // fixmap
    i += 1;
    i += wStr(out, i, "state");
    i += wBin8(out, i, sb[0..8]);
    i += wStr(out, i, "ops");
    out[i] = 0x91; // fixarray, 1 element
    i += 1;
    out[i] = 0x82; // fixmap, 2 pairs
    i += 1;
    i += wStr(out, i, "event");
    i += wStr(out, i, event);
    i += wStr(out, i, "win");
    i += wU32(out, i, s.win);
    if (!terminal) {
        i += wStr(out, i, "awaiting");
        out[i] = 0x81; // fixmap, 1 pair
        i += 1;
        i += wStr(out, i, "type");
        i += wStr(out, i, "gamble");
    }
    return i;
}

export fn open(prev_p: i32, prev_l: i32, ctx_p: i32, ctx_l: i32, out_p: i32, out_max: i32) i32 {
    _ = prev_p;
    _ = prev_l;
    _ = ctx_p;
    _ = ctx_l;
    _ = out_max;
    const w = baseWin(rng_next());
    const s = State{ .gambles = 0, .done = if (w == 0) 1 else 0, .win = w };
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    return @intCast(encodeProgress(out, s, "deal"));
}

export fn step(state_p: i32, state_l: i32, act_p: i32, act_l: i32, out_p: i32, out_max: i32) i32 {
    _ = state_l;
    _ = act_p;
    _ = act_l;
    _ = out_max;
    // Single action type ("gamble"); the wrapper already validated it, and
    // collect = closeRound, so we never decode the action payload.
    const sp: [*]const u8 = @ptrFromInt(@as(usize, @intCast(state_p)));
    var s = State.read(sp);
    if (rng_next() < P_WIN) {
        s.win *= 2;
        s.gambles += 1;
        if (s.gambles >= MAX_GAMBLES) s.done = 1; // cap reached -> terminal
    } else {
        s.win = 0;
        s.done = 1; // busted
    }
    const event: []const u8 = if (s.win == 0) "bust" else "gamble";
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    return @intCast(encodeProgress(out, s, event));
}

export fn is_terminal(state_p: i32, state_l: i32) i32 {
    _ = state_l;
    const sp: [*]const u8 = @ptrFromInt(@as(usize, @intCast(state_p)));
    const s = State.read(sp);
    return if (s.done == 1) 1 else 0;
}

// close outcome: { multiplier, ops: [], type }
fn encodeClose(out: [*]u8, s: State) usize {
    const mult: f64 = @floatFromInt(s.win);
    var i: usize = 0;
    out[i] = 0x83; // fixmap, 3 pairs
    i += 1;
    i += wStr(out, i, "multiplier");
    i += wF64(out, i, mult);
    i += wStr(out, i, "ops");
    out[i] = 0x90; // empty fixarray
    i += 1;
    i += wStr(out, i, "type");
    i += wStr(out, i, if (s.win > 0) "win" else "loss");
    return i;
}

export fn close(state_p: i32, state_l: i32, out_p: i32, out_max: i32) i32 {
    _ = state_l;
    _ = out_max;
    const sp: [*]const u8 = @ptrFromInt(@as(usize, @intCast(state_p)));
    const s = State.read(sp);
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    return @intCast(encodeClose(out, s));
}

// External-trigger autoclose (wallet/admin), never timer-driven inside the RGS.
export fn autoclose(state_p: i32, state_l: i32, out_p: i32, out_max: i32) i32 {
    return close(state_p, state_l, out_p, out_max);
}

// --- in-WASM self-play: prove the fair gamble is EV-neutral --------------
// Policy: gamble up to `stop_after` times, then collect (a bust ends early). The
// RTP comes out ~0.96 for EVERY stop_after - only the variance (and max win)
// grows. Same baseWin() + fair flip the served game uses.
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

export fn sim_gamble(spins: u32, seed_hi: u32, seed_lo: u32, stop_after: u32, out_p: i32) void {
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
        var win: u32 = baseWin(rng.next());
        var g: u32 = 0;
        while (win > 0 and g < stop_after and g < MAX_GAMBLES) {
            if (rng.next() < P_WIN) {
                win *= 2;
                g += 1;
            } else {
                win = 0;
            }
        }
        const ret: f64 = @floatFromInt(win);
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
