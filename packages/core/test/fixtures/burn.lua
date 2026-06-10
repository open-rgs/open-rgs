-- Simple math with a deterministic busy loop. Exists for the endurance +
-- concurrency tests: real maths spend real time inside the VM, and the loop
-- runs >100k Lua instructions per call so the watchdog's count hook actually
-- fires mid-call - the production shape, not a toy. Still far under any
-- watchdog budget.
return {
  kind = "simple",
  name = "test-burn",
  version = "1.0.0",
  rtp = 1.0,
  play = function(prev, ctx)
    local x = 1
    for _ = 1, 50000 do
      x = (x * 31 + 7) % 1000003
    end
    local r = host.rng_next()
    return {
      multiplier = (r < 0.5) and 2 or 0,
      ops = { { kind = "result", burn = x } },
      type = (r < 0.5) and "win" or "loss",
    }
  end,
}
