---
"@open-rgs/meters": minor
---

Bounds, spending, and living in carry.

**A floor and a ceiling.** A counter needs neither; a multiplier that starts at
1x and tops out at 10x needs both. Collecting past the ceiling clamps rather
than throwing, because a spin that collects more than the meter can hold is a
good spin. `fillLevel` reports how full the meter is between those bounds,
which is a different question from `progress`, and drawn on a different bar.

**Spending it down.** `spend` takes from the count and stops at the floor. A
threshold already earned stays earned, so a player who spends a meter and
refills it is not paid for the same rung twice - `reawardAfterSpend` says
otherwise for games where that is the point.

**Carry.** A meter that outlasts a spin has to live in the math's carry, since
the engine keeps no per-player state of its own. `toCarry` writes a short
versioned form; `fromCarry` reads it back, clamping into whatever the bounds
are NOW, since they may have tightened since it was written.

That makes the meter's serialised shape part of the game's persisted state, so
`fromCarry` takes a migration strategy for carry it cannot read: `"reset"`
(the engine's own answer to a math-version change: nothing paid twice, nothing
parsed wrongly), `"keep-count"` (keep the progress and let the passed rungs pay
again, which is generous in some games and double-paying in others), or a
function that reads the old shape and returns the meter it should become - the
only option that keeps both progress and awards.
