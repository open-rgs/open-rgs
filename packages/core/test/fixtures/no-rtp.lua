-- A simple math that deliberately omits `rtp`  - exercises the L8 default +
-- warning path.
return {
  kind = "simple",
  name = "no-rtp",
  version = "1.0.0",
  play = function(prev, ctx)
    return { multiplier = 0, ops = {}, type = "loss" }
  end,
}
