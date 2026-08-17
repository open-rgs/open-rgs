#!/usr/bin/env python3
"""Generate one docs route per slot library.

Each page is a lede, three animatics of the ideas that matter, a coloured code
sample, and one paragraph of why. Kept in a generator so the thirteen-plus
pages stay consistent as the set grows.
"""
import pathlib

OUT = pathlib.Path(__file__).parent / "src/pages/extension"

LIBS = [
 ("grid", "Grid", "The board",
  "Shape is a height per column, not width by height.",
  [("grid-ragged", "The fifth cell exists in the tall reels and is simply absent from the short ones."),
   ("grid-order", "Cells are stored flat, column-major. One array per board, not one per column."),
   ("grid-neighbours", "Neighbours are asked for, never computed - on a ragged board a cell can have a left neighbour and no right one.")],
  '''import { rect, makeGrid, at, countOf } from "@open-rgs/grid";

// Rectangular is the case where every column happens to match.
const SHAPE  = rect(5, 3);          // [3, 3, 3, 3, 3]
const RAGGED = [4, 5, 5, 5, 5, 4];  // ordinary, not a special case

const board = makeGrid(SHAPE, () => "LOW");

at(board, 1, 4);       // undefined - off the grid, reported not thrown
countOf(board, "LOW"); // 15''',
  "Ragged reel sets are ordinary in production slots. An evaluator written against a rectangle bakes that assumption into every traversal, so adding ragged support later is a rewrite of everything that reads a grid."),

 ("weights", "Weights", "Exact sampling",
  "The number you read is the number you get.",
  [("weights-bands", "The pointer lands in each band exactly as often as its declared weight."),
   ("weights-zero", "A zero-weight symbol is unreachable at every draw, including the very top of the range."),
   ("weights-distinct", "pickDistinct draws without replacement, and refuses rather than returning fewer than asked.")],
  '''import { sampler, pickDistinct } from "@open-rgs/weights";

const symbols = sampler({ LOW: 60, MID: 30, HIGH: 9, WILD: 1 });

symbols.probabilityOf("WILD");  // 0.01 - readable, not inferred
symbols.pick(host.rng_next());  // draws from the injected stream

// Three different high symbols, never the same one twice.
pickDistinct(highs, 3, host.rng_next);''',
  "A reel strip encodes probability indirectly - you move symbols around an array to shift odds. A weighted set answers the question directly, and that readability is the balancing story: RTP is a sum of probability times payout."),

 ("selectors", "Selectors", "Which cells?",
  "One primitive serving placement and hold-and-win targeting.",
  [("selectors-pick", "A selector names cells. Everything else does something to them."),
   ("selectors-compose", "They compose: union, intersect, except, not."),
   ("selectors-random", "randomN draws without replacement and throws rather than under-delivering.")],
  '''import { cols, holding, randomN, except } from "@open-rgs/selectors";

// "Three cells on the first two reels, none of them wild"
const target = randomN(3, except(cols([0, 1]), holding("WILD")));

const cells = target(grid, host.rng_next);''',
  "Placement and hold-and-win targeting are the same shape: pick some positions, then act on them. Only the first half varies, so it lives once. Order is column-major and stable, because a selector returning set-iteration order would make a seeded replay diverge between versions."),

 ("fill", "Fill", "Frequency",
  "Weighted draws, one cell at a time.",
  [("fill-roll", "Every cell drawn independently from the same weighted set."),
   ("fill-percolumn", "Per-column sets let a wild land only on the middle reels."),
   ("fill-expected", "expectedCount makes &quot;how many scatters per spin&quot; arithmetic rather than a simulation.")],
  '''import { fillWeights, fillWeightsPerColumn, expectedCount } from "@open-rgs/fill";

const reels = fillWeights(SHAPE, { LOW: 55, HIGH: 12, WILD: 5 });

// No wild on the outer reels.
const gated = fillWeightsPerColumn(SHAPE, [
  { LOW: 60, HIGH: 12, WILD: 0 },
  { LOW: 55, HIGH: 12, WILD: 5 },
  { LOW: 55, HIGH: 12, WILD: 5 },
  { LOW: 55, HIGH: 12, WILD: 5 },
  { LOW: 60, HIGH: 12, WILD: 0 },
]);''',
  "This is the direct strip replacement, and it deliberately does not do adjacency - that belongs to markov, layered on top. Most balancing work is frequency work and should not require thinking about neighbours."),

 ("markov", "Markov", "Stacking",
  "Changes how clumpy reels look. Provably does not change frequency.",
  [("markov-pair", "Two columns, same symbols, same rates. Only the runs differ."),
   ("markov-runs", "High stickiness produces natural stacks, which is the one thing a strip gave you."),
   ("markov-stationary", "The chain settles on exactly the base distribution, whatever the stickiness.")],
  '''import { stackyFill, sticky, stationary, meanRunLength } from "@open-rgs/markov";

const BASE = { LOW: 60, MID: 30, HIGH: 10 };

// 0.35 gives visible stacking. Turn it up and frequency does not move.
const reels = stackyFill(SHAPE, BASE, 0.35);

stationary(sticky(BASE, 0.9));      // still { LOW: .6, MID: .3, HIGH: .1 }
meanRunLength(BASE, 0.35, "HIGH");  // how tall the stacks look''',
  "Under sticky(base, s) the stationary distribution is exactly base for every s below 1. So s is a pure feel knob: turn it up for stacks and your RTP does not move. That is the property a reel strip cannot offer, because a strip tangles frequency and adjacency together."),

 ("recipes", "Recipes", "Named boards",
  "Every board comes from exactly one declared recipe.",
  [("recipes-mix", "One recipe chosen per board, at its declared probability."),
   ("recipes-tease", "A tease is a real draw that goes through the pay evaluator honestly."),
   ("recipes-place", "place() writes symbols into cells a selector picked.")],
  '''import { recipes, place, stack } from "@open-rgs/recipes";
import { randomN, cols } from "@open-rgs/selectors";

const board = recipes([
  { name: "base",        p: 0.94, draw: reels },
  { name: "two-scatter", p: 0.05, draw: place(2, "SC", randomN(2, cols([0, 1])), reels) },
  { name: "high-stack",  p: 0.01, draw: stack("HIGH", 2, reels) },
]);

const { grid, recipe } = board(host.rng_next);
board.probabilityOf("two-scatter");  // 0.05 - the tease rate, declared''',
  "RTP becomes a sum over recipes, each independently measurable. Decorating a drawn board instead would misprice RTP silently, and build the near-miss behaviour regulators prohibit. Probabilities must sum to 1: a mixture summing to 0.98 misprices every spin."),

 ("paytable", "Paytable", "What things are worth",
  "One shared notion of payout, wild and scatter.",
  [("paytable-bands", "bands() expands size ranges into the exact counts a paytable stores."),
   ("paytable-wild", "A wild substitutes for anything except a scatter."),
   ("paytable-topband", "The top band is open-ended and runs all the way to maxCount.")],
  '''import { paytable, bands, totalMultiplier } from "@open-rgs/paytable";

const PAY = paytable({ HIGH: { 3: 10, 4: 50, 5: 200 } });

// Cluster games pay by size range. 49 = the grid size.
const CLUSTER = paytable(bands({ HIGH: [[5, 2], [9, 6], [12, 22]] }, 49));

const roles = { wilds: ["WILD"], scatters: ["SC"] };''',
  "All four evaluators read this, so a symbol means the same thing in each. Watch the top band: it is open-ended. On a 49-cell board seven or more scatters is common, not a lottery ticket, and the intuition from a five-reel grid does not transfer."),

 ("pay-lines", "Pay-lines", "Runs along a line",
  "Longest run, paid once.",
  [("pay-lines-run", "A run must be anchored at the leftmost reel."),
   ("pay-lines-wildopen", "A wild-opening run pays whichever reading is worth more."),
   ("pay-lines-bothways", "Under bothWays the two directions compete rather than accumulate.")],
  '''import { evalLines, rowLines } from "@open-rgs/pay-lines";
import { totalMultiplier } from "@open-rgs/paytable";

const LINES = rowLines(5, 3);   // three straight rows

const wins = evalLines(grid, LINES, PAY, { roles, bothWays: false });
const mult = totalMultiplier(wins);''',
  "Paying every prefix - three of a kind and four and five on the same run - roughly doubles a game's RTP. A wild never substitutes for a scatter, or it manufactures feature triggers, and feature frequency is usually the biggest term in RTP."),

 ("pay-ways", "Pay-ways", "Consecutive columns",
  "Paid by the product of per-column counts.",
  [("pay-ways-cols", "Two on the first reel, one on the second, three on the third: six ways."),
   ("pay-ways-gap", "A gap ends the run. Counting past it inflates both the count and the multiplier."),
   ("pay-ways-heights", "On a multiways board the heights vary per spin, and this needs no change.")],
  '''import { evalWays, totalWays } from "@open-rgs/pay-ways";

const wins = evalWays(grid, PAY, { roles });

totalWays(grid);   // 1024 on a 4x5, 243 on a 3x5 - a consequence, not a setting

// wins[0].ways is the product of per-column MATCH counts,
// which is why a variable-height board needs no special evaluator.''',
  "Ways games are dense, so a prefix-paying bug here is far worse than on lines: nearly every spin would win. Each symbol pays at most once, for its longest contiguous run from the first reel."),

 ("pay-anywhere", "Pay-anywhere", "Scatters",
  "Total count, position irrelevant.",
  [("pay-anywhere-scatter", "Counted anywhere on the board, in any arrangement."),
   ("pay-anywhere-nowild", "A wild never counts. Substitution here would manufacture triggers."),
   ("pay-anywhere-trigger", "Triggering is a separate question from paying.")],
  '''import { evalScatters, triggersOn, shortOfTrigger } from "@open-rgs/pay-anywhere";

const wins = evalScatters(grid, PAY, { roles });

triggersOn(grid, "SC", 3);      // does the feature start?
shortOfTrigger(grid, "SC", 3);  // the number a tease is built around''',
  "The smallest evaluator with the largest effect on a game's shape, because it is almost always what starts the feature. Plenty of games trigger on three scatters while paying nothing for them, so the two questions stay separate."),

 ("pay-cluster", "Pay-cluster", "Connected groups",
  "A wild belongs to every cluster it touches.",
  [("pay-cluster-wild", "The outlined wild is counted in the teal group and the amber one."),
   ("pay-cluster-flood", "A flood fill from each real occurrence, spreading through neighbours."),
   ("pay-cluster-diag", "Orthogonal only. Diagonals do not connect.")],
  '''import { evalAllClusters, clustersOf, largestCluster } from "@open-rgs/pay-cluster";

const wins = evalAllClusters(grid, CLUSTER, { roles });

clustersOf(grid, "HIGH", roles);     // groups, for presentation
largestCluster(grid, "HIGH", roles); // biggest group size''',
  "Wilds are the whole difficulty. The fill runs per symbol and consumes only real matches - consume the wild for the first cluster and the second silently shrinks by one, with nothing on the board looking wrong. A cluster is never seeded from a wild, or a lone wild would invent wins."),

 ("cascade", "Cascade", "Tumbles",
  "Clear, fall, refill, repeat.",
  [("cascade-fall", "Winners clear, survivors fall, a fresh symbol drops in on top."),
   ("cascade-ladder", "The ladder climbs per step and applies to that step's own win."),
   ("cascade-bounded", "The loop is capped, because a refill can always win again.")],
  '''import { runCascade } from "@open-rgs/cascade";

const run = runCascade(
  start,
  (g) => {
    const wins = evalAllClusters(g, PAY, { roles });
    return { multiplier: totalMultiplier(wins), positions: wins.flatMap((w) => w.positions) };
  },
  (next) => symbols.pick(next()),
  host.rng_next,
  { stepMultipliers: [1, 2, 3, 5], maxSteps: 30 },
);

run.multiplier;  // total across every step
run.truncated;   // true if the cap fired''',
  "Gravity is per column: a short reel drops a shorter distance, and treating the board as a rectangle produces a shuffle rather than a fall. The ladder applies to each step's own win - applying it to the running total compounds and inflates RTP badly."),

 ("holdwin", "Hold and win", "Respins",
  "A landing resets the counter.",
  [("holdwin-meter", "Respins burn down, then a coin lands and the counter snaps back to full."),
   ("holdwin-collect", "A collector absorbs the value of every coin it targets."),
   ("holdwin-full", "Filling the board pays the top tier.")],
  '''import {
  triggers, beginRespins, stepRespins, isCycleOver, settleRespins,
} from "@open-rgs/holdwin";

const JACKPOTS = { MINI: 8, MINOR: 20, MAJOR: 60, GRAND: 400 };
const CONFIG   = { respins: 3, fullBoardAward: "GRAND" };

if (triggers(grid, 6)) {           // 6 coins on a 5x3
  let s = beginRespins(grid, CONFIG);
  while (!isCycleOver(s)) s = stepRespins(s, landCoins(s.grid), CONFIG);
  const mult = settleRespins(s, CONFIG, JACKPOTS);
}''',
  "A landing resets rather than decrements. That single rule makes the feature feel alive, and it is why a cycle has no natural end - so the max-win cap is what makes the round finite. The five coin mechanics are one shape with different selectors, not five features."),

 ("multiways", "Multiways", "Variable reel heights",
  "Each reel draws its own height, every spin.",
  [("multiways-heights", "Reels grow and shrink independently, so the ways count moves with them."),
   ("multiways-product", "Ways is the product of the heights the spin drew."),
   ("pay-ways-cols", "pay-ways needs no change: it multiplies match counts, never heights.")],
  '''import { heights, multiwaysFillWeights, expectedWays, expectedWaysPayout } from "@open-rgs/multiways";

const H = heights({ 2: 20, 3: 25, 4: 25, 5: 15, 6: 10, 7: 5 }, 6);

const reels = multiwaysFillWeights(H, { LOW: 55, HIGH: 12, WILD: 5 });

expectedWays(H);  // the marketing number
expectedWaysPayout(H, 0.25, (k) => PAY.pay("HIGH", k));  // what to balance against''',
  "The board ways and the multiplier a win receives are different numbers. A k-column win scales as h to the k while the board scales as h to the reel count, so only a paytable weighted entirely on full-length runs tracks board ways. Rescaling a fixed-height paytable by expected ways over-prices the game."),

 ("big-symbols", "Big symbols", "Blocks",
  "One symbol across a block of cells.",
  [("big-fit", "A block needs every column it covers to be tall enough."),
   ("big-counts", "A 2x2 wild really does act as four wilds."),
   ("grid-ragged", "On a ragged board a block that fits elsewhere may not fit here.")],
  '''import { placements, placeRandomBig, blocksOf } from "@open-rgs/big-symbols";

placements(grid.shape, 2, 2);   // every legal top-left corner

const g = placeRandomBig(grid, "WILD", 2, 2, host.rng_next);

// For presentation only - the maths never needs it.
blocksOf(g, "WILD", [[2, 2], [3, 3]]);''',
  "A big symbol is the same symbol repeated across every cell it covers. No overlay, no marker. That is what makes it work with every evaluator for free, and it matches what players are paid. placeBig refuses rather than clipping, because a clipped 2x2 is a 2x1 pretending to be one."),

 ("scatters", "Scatters", "Spawned as an event",
  "The trigger rate is a parameter, not an emergent property.",
  [("spawn-count", "The count distribution is declared, so the trigger rate is written down."),
   ("spawn-onereel", "At most one per reel by default, which is what makes the count exact."),
   ("spawn-protect", "Protected symbols are never eaten - a wild about to pay stays put.")],
  '''import { withScatters, probabilityOfAtLeast, oneInFor } from "@open-rgs/scatters";

// The base reels carry SC at weight ZERO - it cannot appear naturally.
const config = {
  symbol:   "SC",
  count:    { 0: 9000, 1: 700, 2: 250, 3: 45, 4: 5 },
  reels:    [1, 2, 3],
  protects: ["WILD"],
};

const board = withScatters(reels, config);

oneInFor(config, 3);  // 200 - the feature fires 1 spin in 200''',
  "With a natural scatter the trigger rate is an emergent property of per-cell probability and grid size, tuned by guessing a weight and re-simulating. Spawning inverts that: the count distribution is the trigger rate, readable without a simulation."),
]

PAGE = '''---
import BaseLayout from "../../layouts/BaseLayout.astro";
import Anim from "../../components/Anim.astro";
import Code from "../../components/Code.astro";

const sample = `{code}`;
---

<BaseLayout
  title="@open-rgs/{slug}  - {tag}"
  description="{name}: {lede}"
>
  <main>
    <p class="dim"><a href="/extension">&larr; extensions</a></p>
    <h1>@open-rgs/{slug}</h1>

    <p class="lede">{lede}</p>

{anims}

    <h2 data-section="&sect; 1">Using it</h2>
    <Code code={{sample}} />

    <h2 data-section="&sect; 2">Why</h2>
    <p>{body}</p>
  </main>
</BaseLayout>
'''

for slug, name, tag, lede, anims, code, body in LIBS:
    block = "\n".join(f'    <Anim kind="{k}" caption="{c}" />' for k, c in anims)
    OUT.joinpath(f"{slug}.astro").write_text(
        PAGE.format(slug=slug, name=name, tag=tag, lede=lede, anims=block, code=code, body=body))

rows = "\n".join(
    f'      <li><a href="/extension/{s}">@open-rgs/{s}</a>  - <span class="dim">{l}</span></li>'
    for s, n, t, l, a, c, b in LIBS)
OUT.joinpath("_rows.html").write_text(rows)
print(f"wrote {len(LIBS)} pages, {sum(len(a) for _, _, _, _, a, _, _ in LIBS)} animatics")
