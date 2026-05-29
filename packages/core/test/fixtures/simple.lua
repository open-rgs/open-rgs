-- Minimal simple-round math used by the lua-math loader tests.
-- The multiplier is driven entirely by the injected host.rng_next so tests
-- can assert which RNG was actually used.
return {
  kind = "simple",
  name = "test-simple",
  version = "1.0.0",
  rtp = 1.0,
  play = function(prev, ctx)
    local r = host.rng_next()
    return {
      multiplier = (r < 0.5) and 2 or 0,
      ops = {},
      type = (r < 0.5) and "win" or "loss",
    }
  end,
}
