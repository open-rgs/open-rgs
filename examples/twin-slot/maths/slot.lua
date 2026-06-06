-- twin-slot: a minimal SIMPLE-round slot in Lua - the twin of maths/slot.zig.
--
-- This is one half of a matched pair. maths/slot.zig is the EXACT same game
-- compiled to WASM; test/twin-slot.test.ts proves the two return byte-identical
-- outcomes for the same RNG stream. Read them side by side to see how the same
-- math looks in each runtime - Lua is the quick/expressive way to write it,
-- the Zig/WASM twin is the fast way to run it, and the engine can't tell them
-- apart.
--
-- The game: one RNG draw -> a paytable. EV (RTP) = 0.96:
--     0.02*20 + 0.04*5 + 0.36*1 = 0.40 + 0.20 + 0.36 = 0.96
-- Keep this ladder and slot.zig's decide() in lock-step - same thresholds, same
-- payouts, exactly one draw - or the parity test fails. That's the contract.

return {
  kind    = "simple",
  name    = "twin-slot",
  version = "1.0.0",
  rtp     = 0.96,

  play = function(_prev, _ctx)
    local r = host.rng_next()

    local mult
    if     r < 0.02 then mult = 20
    elseif r < 0.06 then mult = 5
    elseif r < 0.42 then mult = 1
    else                 mult = 0
    end

    return {
      multiplier = mult,
      ops        = { { kind = "spin", mult = mult } },
      type       = mult > 0 and "win" or "loss",
    }
  end,
}
