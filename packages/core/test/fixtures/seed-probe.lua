-- Probes whether the seed-expand generator globals leak into the math sandbox.
-- multiplier = 1 if reachable (BAD: math could reseed/peek), 0 if hidden (good).
return {
  kind = "simple", name = "seed-probe", version = "1.0.0", rtp = 0,
  play = function()
    local reachable = (__open_rgs_xoshiro_reseed ~= nil) or (__open_rgs_xoshiro_next ~= nil)
    return { multiplier = reachable and 1 or 0, ops = {}, type = "probe" }
  end,
}
