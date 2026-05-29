-- Probes the math VM sandbox. Reports (via carry) which dangerous globals
-- are still reachable and what math.random() returns, so the test can
-- assert the environment is locked down and math.random is routed through
-- the injected host RNG.
return {
  kind = "simple",
  name = "sandbox-probe",
  version = "1.0.0",
  rtp = 0,
  play = function(prev, ctx)
    local leaked = {}
    local function chk(name, v) if v ~= nil then leaked[#leaked + 1] = name end end
    chk("os", os)
    chk("io", io)
    chk("debug", debug)
    chk("load", load)
    chk("loadstring", loadstring)
    chk("loadfile", loadfile)
    chk("dofile", dofile)
    chk("package", package)
    chk("collectgarbage", collectgarbage)
    local report = table.concat(leaked, ",") .. "|rand=" .. tostring(math.random())
    return { multiplier = 0, ops = {}, type = "probe", carry = report }
  end,
}
