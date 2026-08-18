---
"@open-rgs/cascade": minor
"@open-rgs/big-symbols": minor
"@open-rgs/paytable": patch
---

Gaps found while auditing the extension set against what the genre actually
uses.

**cascade** reports which cells were refilled on each step. Not the same list
as `cleared`: gravity moves survivors down, so the holes that get filled are
at the top of every column that lost a cell, wherever the win happened to be.
A client animating the drop needs that, and so does any mechanic that counts
only new symbols.

**big-symbols** gains the expanding symbol. A block is a symbol that ARRIVES
big; an expanding symbol arrives normal and grows to fill its reel, which is
the book game's special symbol and the expanding wild. `expandSymbol` fills
every column holding it (each to its own height, so a ragged reel is filled
short), `columnsHolding` names the candidates, and `expansionCells` reports
what would be written without writing it, for a client that animates the
growth first.

**paytable** has tests of its own. It was covered only through the four
evaluators that import it, so a change here failed somewhere else or nowhere,
in the one module where all four agree about what a symbol is worth and what a
wild may stand in for.
