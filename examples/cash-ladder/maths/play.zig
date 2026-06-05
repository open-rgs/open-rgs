// Example complex-round math in Zig: a "cash ladder" gamble.
//
// A complex round is a state machine: open -> step* -> close. The catch is that
// the kernel keeps NOTHING between calls - core stores the round's `state` (an
// opaque string) and threads it back into the next step / is_terminal / close.
// So every call must (de)serialize the FULL round state. That is exactly why a
// round survives a reconnect or a server restart, and why one reused wasm
// instance can interleave many concurrent rounds: the truth lives in the blob,
// not in a global.
//
// The mechanic: open() starts at 1.00x. Each step() is a "climb" - with
// probability P_BUST the round busts (terminal, pays 0); otherwise the
// multiplier grows and the player may climb again or send CLOSE to cash out.
// close() pays the current multiplier (0 if busted).
//
// State boundary: this kernel owns an opaque 8-byte layout. It emits `state` as
// a MessagePack `bin`; the host (loadWasmMath) base64s it into the contract's
// `RoundState` string and threads it back - the kernel never sees base64, core
// never sees bytes. All other I/O is MessagePack over linear memory.
//
// Build (or use the committed play.wasm):
//   zig build-exe play.zig -target wasm32-freestanding -fno-entry -rdynamic \
//     -OReleaseSmall -femit-bin=play.wasm

extern "host" fn rng_next() f64;

const NAME: []const u8 = "cash-ladder";
const VERSION: []const u8 = "1.0.0";

const MAX_LEVEL: u8 = 12; // ladder height (terminal at the top)
const P_BUST: f64 = 0.25; // bust chance per climb
const GROWTH_X1000: u32 = 1280; // x1.28 per climb -> ~0.96 per-climb RTP

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
    return 9600; // nominal; true RTP is strategy-dependent (when you cash out)
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

// --- the kernel's own opaque state layout (8 bytes) ---------------------
const State = struct {
    level: u8,
    busted: u8,
    mult_x1000: u32,

    fn read(p: [*]const u8) State {
        return .{
            .level = p[0],
            .busted = p[1],
            .mult_x1000 = @as(u32, p[4]) | (@as(u32, p[5]) << 8) |
                (@as(u32, p[6]) << 16) | (@as(u32, p[7]) << 24),
        };
    }
    fn write(self: State, p: [*]u8) void {
        p[0] = self.level;
        p[1] = self.busted;
        p[2] = 0;
        p[3] = 0;
        p[4] = @intCast(self.mult_x1000 & 0xff);
        p[5] = @intCast((self.mult_x1000 >> 8) & 0xff);
        p[6] = @intCast((self.mult_x1000 >> 16) & 0xff);
        p[7] = @intCast((self.mult_x1000 >> 24) & 0xff);
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

// open/step outcome: { state: bin, ops: [{level, mult_x1000}], awaiting?: {type:"climb"} }
fn encodeProgress(out: [*]u8, s: State, terminal: bool) usize {
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
    i += wStr(out, i, "level");
    i += wU32(out, i, @as(u32, s.level));
    i += wStr(out, i, "mult_x1000");
    i += wU32(out, i, s.mult_x1000);
    if (!terminal) {
        i += wStr(out, i, "awaiting");
        out[i] = 0x81; // fixmap, 1 pair
        i += 1;
        i += wStr(out, i, "type");
        i += wStr(out, i, "climb");
    }
    return i;
}

export fn open(prev_p: i32, prev_l: i32, ctx_p: i32, ctx_l: i32, out_p: i32, out_max: i32) i32 {
    _ = prev_p;
    _ = prev_l;
    _ = ctx_p;
    _ = ctx_l;
    _ = out_max;
    const s = State{ .level = 0, .busted = 0, .mult_x1000 = 1000 };
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    return @intCast(encodeProgress(out, s, false));
}

export fn step(state_p: i32, state_l: i32, act_p: i32, act_l: i32, out_p: i32, out_max: i32) i32 {
    _ = state_l;
    _ = act_p;
    _ = act_l;
    _ = out_max;
    // The wrapper validates action.type == awaiting.type ("climb") before
    // calling, so a single-action game need not decode the action payload.
    const sp: [*]const u8 = @ptrFromInt(@as(usize, @intCast(state_p)));
    var s = State.read(sp);
    if (rng_next() < P_BUST) {
        s.busted = 1;
    } else {
        s.level += 1;
        s.mult_x1000 = @intCast((@as(u64, s.mult_x1000) * @as(u64, GROWTH_X1000)) / 1000);
    }
    const terminal = s.busted == 1 or s.level >= MAX_LEVEL;
    const out: [*]u8 = @ptrFromInt(@as(usize, @intCast(out_p)));
    return @intCast(encodeProgress(out, s, terminal));
}

export fn is_terminal(state_p: i32, state_l: i32) i32 {
    _ = state_l;
    const sp: [*]const u8 = @ptrFromInt(@as(usize, @intCast(state_p)));
    const s = State.read(sp);
    return if (s.busted == 1 or s.level >= MAX_LEVEL) 1 else 0;
}

// close outcome: { multiplier, ops, type }
fn encodeClose(out: [*]u8, s: State) usize {
    const mult: f64 = if (s.busted == 1) 0 else @as(f64, @floatFromInt(s.mult_x1000)) / 1000.0;
    var i: usize = 0;
    out[i] = 0x83; // fixmap, 3 pairs
    i += 1;
    i += wStr(out, i, "multiplier");
    i += wF64(out, i, mult);
    i += wStr(out, i, "ops");
    out[i] = 0x90; // empty fixarray
    i += 1;
    i += wStr(out, i, "type");
    i += wStr(out, i, if (s.busted == 1) "bust" else "cashout");
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

// --- in-VM batch self-play (the simulator's fast tier for OPTIONS) -------
// The whole policy loop runs INSIDE the kernel, so sweeping the "stop at level
// N" policy needs no per-step JS<->WASM crossing - the same trick the simple
// sim_batch uses, now with the player's policy baked in. RTP is policy-relative,
// so this answers "what RTP if the player climbs N rungs?" at ~native speed.

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

// Self-play `spins` rounds under the policy "climb until level == stop_level"
// (bust with prob P_BUST per climb). Uses the SAME integer payout math as
// step(), so the measured RTP is the served game's. Writes 6 little-endian f64:
// count, sum, sumsq, min, max, hits - the aggregate reportFromAggregate consumes.
export fn sim_ladder(spins: u32, seed_hi: u32, seed_lo: u32, stop_level: u32, out_p: i32) void {
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
        var level: u32 = 0;
        var mult_x1000: u32 = 1000;
        var busted = false;
        while (level < stop_level) {
            if (rng.next() < P_BUST) {
                busted = true;
                break;
            }
            level += 1;
            mult_x1000 = @intCast((@as(u64, mult_x1000) * @as(u64, GROWTH_X1000)) / 1000);
        }
        const ret: f64 = if (busted) 0 else @as(f64, @floatFromInt(mult_x1000)) / 1000.0;
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
