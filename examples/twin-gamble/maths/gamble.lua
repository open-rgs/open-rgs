-- twin-gamble: a minimal COMPLEX-round game in Lua - the twin of gamble.zig.
--
-- One half of a matched pair. maths/gamble.zig is the EXACT same game compiled
-- to WASM; test/twin-gamble.test.ts drives a full open -> step* -> close
-- lifecycle through BOTH and asserts identical outcomes for the same RNG stream.
-- This is the readable reference for "how a complex round works."
--
-- THE MECHANIC - fair double-or-nothing:
--   open()  deals a base win from a paytable (EV 0.96) and, if it's > 0, awaits.
--   step()  is one FAIR gamble: heads (p=0.5) doubles the win, tails busts to 0.
--   close() pays the current win. To COLLECT, the player just closes instead of
--           stepping again (collect = the closeRound request, not an action) -
--           so step() never inspects the action, which keeps the Lua and Zig
--           twins trivially identical.
--
-- COMPLEX-ROUND KEY IDEA: the math keeps NOTHING between calls. Core stores the
-- round's `state` (an opaque string) and threads it back into the next
-- step/is_terminal/close. So every call (de)serializes the FULL state. Here we
-- encode it as a tiny "gambles,done,win" string; the Zig twin uses an 8-byte
-- blob. The encoding is private to each runtime - only the OUTCOMES must match.
--
-- WHY IT'S INTERESTING: a fair gamble is EV-neutral, so the round's RTP equals
-- the base slot's (~0.96) under ANY gamble policy. Gambling moves variance, not
-- edge. (Contrast examples/cash-ladder, whose climb is UNFAIR and erodes RTP.)

local MAX_GAMBLES = 8   -- 2^8 = 256x the base win, max
local P_WIN       = 0.5 -- FAIR double-or-nothing (EV-neutral)

-- Base paytable. MUST mirror gamble.zig's baseWin() exactly. EV = 0.96:
--   0.18*2 + 0.60*1 = 0.36 + 0.60 = 0.96
local function baseWin(r)
  if     r < 0.18 then return 2
  elseif r < 0.78 then return 1
  else                 return 0
  end
end

-- State (de)serialization. "gambles,done,win" - all non-negative integers.
local function enc(gambles, done, win)
  return gambles .. "," .. done .. "," .. win
end
local function dec(s)
  local g, d, w = string.match(s, "(%d+),(%d+),(%d+)")
  return tonumber(g), tonumber(d), tonumber(w)
end

-- open/step share this outcome shape: { state, ops:[{event,win}], awaiting? }.
local function progress(gambles, done, win, event)
  return {
    state    = enc(gambles, done, win),
    ops      = { { event = event, win = win } },
    awaiting = (done == 0) and { type = "gamble" } or nil,
  }
end

return {
  kind    = "complex",
  name    = "twin-gamble",
  version = "1.0.0",
  rtp     = 0.96, -- policy-invariant: the gamble is fair

  open = function(_prev, _ctx)
    local w = baseWin(host.rng_next())
    local done = (w == 0) and 1 or 0 -- a losing spin has nothing to gamble
    return progress(0, done, w, "deal")
  end,

  step = function(state, _action)
    -- Single action type ("gamble"); the wrapper validated it and collect =
    -- closeRound, so we never inspect the action.
    local gambles, done, win = dec(state)
    if host.rng_next() < P_WIN then
      win = win * 2
      gambles = gambles + 1
      if gambles >= MAX_GAMBLES then done = 1 end -- cap reached -> terminal
    else
      win = 0
      done = 1                                    -- busted
    end
    local event = (win == 0) and "bust" or "gamble"
    return progress(gambles, done, win, event)
  end,

  is_terminal = function(state)
    local _, done, _ = dec(state)
    return done == 1
  end,

  close = function(state)
    local _, _, win = dec(state)
    return { multiplier = win, ops = {}, type = (win > 0) and "win" or "loss" }
  end,

  -- External-trigger autoclose (wallet/admin), never timer-driven inside the RGS.
  autoclose = function(state)
    local _, _, win = dec(state)
    return { multiplier = win, ops = {}, type = (win > 0) and "win" or "loss" }
  end,
}
