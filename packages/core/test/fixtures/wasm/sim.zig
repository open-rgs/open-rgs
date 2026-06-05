// Native multithreaded simulator. Uses the SAME kernel.zig as play.wasm, so it
// measures byte-identically what the WASM you ship produces (parity test gates
// this). Threads = std.Thread (rayon is Rust; this is the Zig equivalent).
//
// Build: zig build-exe sim.zig -OReleaseFast -femit-bin=sim
// Run:   ./sim <spins> <seedHi> <seedLo> <threads>
//        -> JSON {count,sum,sumsq,min,max,hits,threads,elapsedMs} on stdout.
// With threads=1 the run is a single slice (hi,lo) == WASM sim_batch(spins,hi,lo).

const std = @import("std");
const kernel = @import("kernel.zig");

fn mix32(x0: u32) u32 {
    var x = x0;
    x = (x ^ (x >> 16)) *% 0x85ebca77;
    x = (x ^ (x >> 13)) *% 0xc2b2ae3d;
    return x ^ (x >> 16);
}

const Worker = struct {
    spins: u64,
    hi: u32,
    lo: u32,
    out: kernel.Stats = .{},
    fn run(self: *Worker) void {
        self.out = kernel.runSlice(self.spins, self.hi, self.lo);
    }
};

pub fn main() !void {
    const alloc = std.heap.page_allocator;
    const argv = try std.process.argsAlloc(alloc);
    defer std.process.argsFree(alloc, argv);

    var spins: u64 = 1_000_000;
    var hi: u32 = 0;
    var lo: u32 = 0;
    var threads: u32 = 1;
    if (argv.len > 1) spins = try std.fmt.parseInt(u64, argv[1], 10);
    if (argv.len > 2) hi = try std.fmt.parseInt(u32, argv[2], 10);
    if (argv.len > 3) lo = try std.fmt.parseInt(u32, argv[3], 10);
    if (argv.len > 4) threads = try std.fmt.parseInt(u32, argv[4], 10);
    if (threads < 1) threads = 1;

    var timer = try std.time.Timer.start();
    var total = kernel.Stats{};

    if (threads == 1) {
        total = kernel.runSlice(spins, hi, lo); // single slice == WASM sim_batch(spins,hi,lo)
    } else {
        const workers = try alloc.alloc(Worker, threads);
        defer alloc.free(workers);
        const handles = try alloc.alloc(std.Thread, threads);
        defer alloc.free(handles);
        const per = spins / threads;
        const rem = spins % threads;
        var i: u32 = 0;
        while (i < threads) : (i += 1) {
            const n = per + (if (i < rem) @as(u64, 1) else 0);
            workers[i] = .{
                .spins = n,
                .hi = mix32(hi ^ (i *% 0x9e3779b1) ^ 0x1),
                .lo = mix32(lo ^ (i *% 0x85ebca77) ^ 0x2),
            };
            handles[i] = try std.Thread.spawn(.{}, Worker.run, .{&workers[i]});
        }
        i = 0;
        while (i < threads) : (i += 1) {
            handles[i].join();
            total.merge(workers[i].out);
        }
    }

    const elapsed_ms = @as(f64, @floatFromInt(timer.read())) / 1.0e6;
    const min = if (total.count > 0) total.min else 0;
    var buf: [512]u8 = undefined;
    const s = try std.fmt.bufPrint(&buf, "{{\"count\":{d},\"sum\":{d},\"sumsq\":{d},\"min\":{d},\"max\":{d},\"hits\":{d},\"threads\":{d},\"elapsedMs\":{d:.2}}}\n", .{ total.count, total.sum, total.sumsq, min, total.max, total.hits, threads, elapsed_ms });
    const f = std.fs.File{ .handle = 1 };
    try f.writeAll(s);
}
