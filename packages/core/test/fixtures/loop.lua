-- A runaway math: play() never returns. Used to prove the loader's
-- execution watchdog aborts it instead of hanging the server. The infinite
-- loop is inside play(), not at module top level, so loadLuaMath itself
-- returns normally and only the *call* trips the deadline.
return {
  kind = "simple",
  name = "loop",
  version = "1.0.0",
  rtp = 0,
  play = function(prev, ctx)
    while true do end
  end,
}
