// Native multithreaded simulator for the hold-&-win kernel. Same kernel.zig as
// play.wasm => byte-parity. Args: <spins> <threads> [pCoin] [pRespin].
// Build: zig build-exe sim.zig -OReleaseFast -femit-bin=sim
const std = @import("std");
const kernel = @import("kernel.zig");

fn mix32(x0: u32) u32 { var x = x0; x = (x ^ (x >> 16)) *% 0x85ebca77; x = (x ^ (x >> 13)) *% 0xc2b2ae3d; return x ^ (x >> 16); }
const Worker = struct { spins: u64, hi: u32, lo: u32, out: kernel.Stats = .{}, fn run(self: *Worker) void { self.out = kernel.runSlice(self.spins, self.hi, self.lo); } };

pub fn main() !void {
    const alloc = std.heap.page_allocator;
    const argv = try std.process.argsAlloc(alloc); defer std.process.argsFree(alloc, argv);
    var spins: u64 = 10_000_000; var threads: u32 = 1;
    if (argv.len > 1) spins = try std.fmt.parseInt(u64, argv[1], 10);
    if (argv.len > 2) threads = try std.fmt.parseInt(u32, argv[2], 10);
    if (argv.len > 3) kernel.P_COIN = try std.fmt.parseFloat(f64, argv[3]);
    if (argv.len > 4) kernel.P_RESPIN = try std.fmt.parseFloat(f64, argv[4]);
    if (threads < 1) threads = 1;

    var timer = try std.time.Timer.start();
    var total = kernel.Stats{};
    if (threads == 1) {
        total = kernel.runSlice(spins, 12345, 6789);
    } else {
        const ws = try alloc.alloc(Worker, threads); defer alloc.free(ws);
        const hs = try alloc.alloc(std.Thread, threads); defer alloc.free(hs);
        const per = spins / threads; const rem = spins % threads;
        var i: u32 = 0;
        while (i < threads) : (i += 1) { const n = per + (if (i < rem) @as(u64, 1) else 0); ws[i] = .{ .spins = n, .hi = mix32(0x1234 ^ (i *% 0x9e3779b1) ^ 1), .lo = mix32(0x6789 ^ (i *% 0x85ebca77) ^ 2) }; hs[i] = try std.Thread.spawn(.{}, Worker.run, .{&ws[i]}); }
        i = 0; while (i < threads) : (i += 1) { hs[i].join(); total.merge(ws[i].out); }
    }
    const ms = @as(f64, @floatFromInt(timer.read())) / 1.0e6;
    const rtp = total.sum / total.count;
    const variance = total.sumsq / total.count - rtp * rtp;
    var buf: [700]u8 = undefined;
    const s = try std.fmt.bufPrint(&buf, "{{\"spins\":{d},\"rtp\":{d:.5},\"stdDev\":{d:.3},\"hitRate\":{d:.5},\"featureRate\":{d:.6},\"grandRate\":{d:.8},\"maxWin\":{d},\"threads\":{d},\"elapsedMs\":{d:.1}}}\n", .{ total.count, rtp, @sqrt(variance), total.hits / total.count, total.feat / total.count, total.grand / total.count, total.max, threads, ms });
    const f = std.fs.File{ .handle = 1 }; try f.writeAll(s);
}
