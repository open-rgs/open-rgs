# @open-rgs/strips

## 0.2.0

### Minor Changes

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - The last mechanics the library set could not express.

  **@open-rgs/strips** is the classic reel: a fixed sequence per column, a stop
  per spin, and the window it shows. The rest of these libraries prefer weighted
  sets and that preference stands, but three cases are real and pretending
  otherwise helps nobody: a port of an existing game HAS strips, some labs ask
  for the listing itself, and adjacency is a strip's whole point, since what can
  appear above what is fixed by the sequence.

  It ships the counting that makes a strip as readable as a weighted set, and
  one figure in particular: at-least-one in a window is NOT the row chance times
  the height. On a reel with a three-tall stack that formula gives 1.125, which
  is not a probability, because a stacked symbol appears in several rows of the
  same window - exactly where a strip game puts its stacks. The expected COUNT
  is height times the row chance, and that one is exact. Both are here so the
  two are not confused for each other.

  **grid** grows: `appendColumn` adds a reel mid-round for the games that do
  that, without renumbering anything, so a payline or a sticky cell written
  against the old board still points where it did.

  **pay-ways** gains `bothWays`, matching pay-lines. The two directions COMPETE
  rather than accumulate, because adding them pays a board-spanning run twice,
  which is the most expensive mistake available in a ways game. Off by default,
  so no existing game starts paying twice.

### Patch Changes

- Updated dependencies [[`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928)]:
  - @open-rgs/grid@0.2.0
