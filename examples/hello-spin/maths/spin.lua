-- hello-spin: minimal single-call slot math.
--
-- 30% small win (x0.5), 10% mid win (x2), 1% big win (x50), rest loss.
-- Theoretical RTP = 0.30*0.5 + 0.10*2.0 + 0.01*50 = 0.85. Tune the
-- thresholds + payouts to land on your target RTP.

return {
  kind    = "simple",
  name    = "hello-spin",
  version = "0.1.0",
  rtp     = 0.85,

  play = function(_prev, _ctx)
    local r = host.rng_next()

    local multiplier
    if     r < 0.30 then multiplier = 0.5
    elseif r < 0.40 then multiplier = 2.0
    elseif r < 0.41 then multiplier = 50.0
    else                 multiplier = 0
    end

    return {
      multiplier = multiplier,
      ops        = { { kind = "result", multiplier = multiplier } },
      type       = multiplier > 0 and "win" or "loss",
    }
  end,
}
