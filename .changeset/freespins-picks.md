---
"@open-rgs/freespins": minor
"@open-rgs/picks": minor
---

Two mechanics the library set had no answer for.

**@open-rgs/freespins** is the bookkeeping between spins: a trigger table
(`{ 3: 10, 4: 15 }`, with counts above the top entry paying the top entry), the
counter, retriggers that add rather than reset, a global multiplier that
survives the spin that earned it, and cells held across spins. `runFreeSpins`
is the loop, with a `maxSpins` backstop for a retrigger rule that always fires.

The ordering it enforces is the part worth having: a spin is paid at the
multiplier that was showing when it was played, and the ladder moves
afterwards. The other order pays the first spin at the second spin's
multiplier, compounds over the feature, and looks right in a screenshot.

**@open-rgs/picks** is the bonus round where the player chooses: pick N of M,
keep revealing until a stop symbol, or spin a weighted wheel. Reveals remove
what they revealed, because a pick round is priced by what it takes off the
board and the with-replacement version pays a different distribution while
looking identical. The stop symbol is included in what was picked, since the
player saw it.

Both ship the arithmetic a designer tunes against rather than leaving it to a
simulation: `expectedPicksBeforeStop(12, 3)` is 2.25, `expectedPickTotal` is
the pool's mean times the picks, and `wheelValue` is what a wheel is worth.
