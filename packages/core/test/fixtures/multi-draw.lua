-- 10 host.rng_next() draws per spin; wins (x1) when the mean of the 10
-- uniforms is < 0.5 (P = 0.5 exactly, by symmetry), so theoretical RTP = 0.5.
-- Used to test rngMode "seed-expand": many draws per spin with a known RTP.
return {
  kind = "simple", name = "multi-draw", version = "1.0.0", rtp = 0.5,
  play = function()
    local sum = 0
    for _ = 1, 10 do sum = sum + host.rng_next() end
    local m = (sum / 10) < 0.5 and 1 or 0
    return { multiplier = m, ops = {}, type = m > 0 and "win" or "loss" }
  end,
}
