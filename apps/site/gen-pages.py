#!/usr/bin/env python3
"""Generate one docs route per slot library.

Each page is a short lede followed by several worked examples. An example is
prose, then the animatic that shows what the prose just said, then the code that
does it - interleaved, so nothing sits in a wall of demos above a wall of text.

Kept in a generator so sixteen-plus routes stay consistent as the set grows.
"""
import pathlib

OUT = pathlib.Path(__file__).parent / "src/pages/extension"

# (slug, name, tag, lede, [ (heading, prose, anim_kind, caption, code), ... ])
LIBS = [

("grid", "Grid", "The board",
 "Shape is a height per column, not width by height.",
 [
  ("Ragged is not a special case",
   "A shape is a list of column heights. Rectangular boards are the case where every entry happens to match, so a 4-5-5-5-5-4 reel set needs no separate code path.",
   "grid-ragged", "The fifth cell exists in the tall reels and is simply absent from the short ones.",
   '''import { rect, makeGrid } from "@open-rgs/grid";

const SHAPE  = rect(5, 3);
const RAGGED = [4, 5, 5, 5, 5, 4];

const board = makeGrid(RAGGED, () => "LOW");'''),

  ("Off the grid reports, never throws",
   "On a ragged board an out-of-range row is normal, not exceptional - a payline crossing a short reel simply has no cell there. So reads report their absence instead of raising.",
   "grid-order", "Cells are stored flat, column-major. One array per board, not one per column.",
   '''import { at, indexOf, countOf } from "@open-rgs/grid";

at(board, 1, 4);
at(board, 0, 4);
indexOf(RAGGED, 0, 4);

countOf(board, "LOW");'''),

  ("Neighbours are asked for",
   "Cluster evaluation walks neighbours, and on a ragged board a cell can have a left neighbour and no right one. Computing that from width and height gets it wrong; asking the shape does not.",
   "grid-neighbours", "Only the neighbours that exist on this shape come back.",
   '''import { neighbours, positionsWhere } from "@open-rgs/grid";

neighbours(RAGGED, { col: 1, row: 4 });

positionsWhere(board, (s) => s === "SC");'''),
 ]),

("weights", "Weights", "Exact sampling",
 "The number you read is the number you get.",
 [
  ("Probability you can read",
   "A reel strip encodes odds indirectly - you move symbols around an array to shift them. A weighted set answers the question directly, and that is the whole balancing story: RTP is a sum of probability times payout.",
   "weights-bands", "The pointer lands in each band exactly as often as its declared weight.",
   '''import { sampler } from "@open-rgs/weights";

const symbols = sampler({ LOW: 60, MID: 30, HIGH: 9, WILD: 1 });

symbols.probabilityOf("WILD");
symbols.distribution();
symbols.pick(host.rng_next());'''),

  ("Zero weight means unreachable",
   "A symbol that exists in the game but cannot be drawn in this mode is a real thing - a scatter excluded from a respin set. It stays in the set, reports probability zero, and never comes out at any draw.",
   "weights-zero", "Unreachable at every value, including the very top of the range.",
   '''const respin = sampler({ COIN: 70, BLANK: 30, SC: 0 });

respin.probabilityOf("SC");
respin.pick(0.999999);'''),

  ("Refusing beats under-delivering",
   "A placement that declared three symbols has already priced three into its RTP. Handing back two would corrupt the model with nothing downstream able to notice, so it throws instead.",
   "weights-distinct", "pickDistinct draws without replacement, one value per item.",
   '''import { pickDistinct } from "@open-rgs/weights";

const highs = sampler({ H1: 1, H2: 1, H3: 1 });

pickDistinct(highs, 3, host.rng_next);
pickDistinct(highs, 4, host.rng_next);'''),
 ]),

("selectors", "Selectors", "Which cells?",
 "One primitive serving placement and hold-and-win targeting.",
 [
  ("Naming cells",
   "Placement and hold-and-win targeting are the same shape: pick some positions, then act on them. Only the first half varies, so it lives here once.",
   "selectors-pick", "A selector names cells. Everything else does something to them.",
   '''import { all, cols, rows, holding } from "@open-rgs/selectors";

cols([0, 1])(grid, host.rng_next);
holding("WILD")(grid, host.rng_next);'''),

  ("They compose",
   "Set operations rather than options. Adding a rule means combining selectors, not growing a config object.",
   "selectors-compose", "Union, intersect, except, not.",
   '''import { except, union, not } from "@open-rgs/selectors";

const target = except(cols([0, 1]), holding("WILD"));

union(cols([0]), holding("SC"));'''),

  ("Random draws are stable",
   "Order is column-major and stable. A selector returning set-iteration order would make a seeded replay diverge between engine versions - a bug that only surfaces in a certification rerun.",
   "selectors-random", "randomN draws without replacement and throws rather than under-delivering.",
   '''import { randomN, upTo, oneOf } from "@open-rgs/selectors";

randomN(3, target);
upTo(3, target);
oneOf(target);'''),
 ]),

("fill", "Fill", "Frequency",
 "Weighted draws, one cell at a time.",
 [
  ("The strip replacement",
   "Every cell drawn independently from one weighted set. This deliberately does not do adjacency - that belongs to markov, layered on top - because most balancing work is frequency work and should not require thinking about neighbours.",
   "fill-roll", "Every cell drawn independently from the same weighted set.",
   '''import { fillWeights } from "@open-rgs/fill";

const reels = fillWeights(SHAPE, { LOW: 55, MID: 25, HIGH: 12, WILD: 5, SC: 3 });

const board = reels(host.rng_next);'''),

  ("Per-column sets",
   "The classic way to differentiate reels: a wild that can only land on the middle three. A short list is an authoring mistake that would otherwise surface as an undefined symbol mid-spin, so it throws at build time.",
   "fill-percolumn", "Per-column sets let a wild land only on the middle reels.",
   '''import { fillWeightsPerColumn } from "@open-rgs/fill";

const gated = fillWeightsPerColumn(SHAPE, [
  { LOW: 60, HIGH: 12, WILD: 0 },
  { LOW: 55, HIGH: 12, WILD: 5 },
  { LOW: 55, HIGH: 12, WILD: 5 },
  { LOW: 55, HIGH: 12, WILD: 5 },
  { LOW: 60, HIGH: 12, WILD: 0 },
]);'''),

  ("Counting without simulating",
   "Cells are independent under these generators, so expectation is the sum of per-cell probabilities. That makes a whole class of questions arithmetic rather than a simulation run.",
   "fill-expected", "How many scatters per spin, computed rather than measured.",
   '''import { expectedCount, cellProbability } from "@open-rgs/fill";

expectedCount(SHAPE, sets, "SC");
cellProbability(sets, 0, "WILD");'''),
 ]),

("markov", "Markov", "Stacking",
 "Changes how clumpy reels look. Provably does not change frequency.",
 [
  ("One knob for feel",
   "Independent draws give exact frequency and no adjacency, so reels never feel like reels. Strips give adjacency but tangle it with frequency. A Markov chain over each column gives both, separately.",
   "markov-pair", "Two columns, same symbols, same rates. Only the runs differ.",
   '''import { stackyFill } from "@open-rgs/markov";

const BASE = { LOW: 60, MID: 30, HIGH: 10 };

const flat   = stackyFill(SHAPE, BASE, 0);
const stacky = stackyFill(SHAPE, BASE, 0.8);'''),

  ("Frequency does not move",
   "Under sticky(base, s) the chain's stationary distribution is exactly base, for every s below 1. So stickiness is a pure feel knob - turn it up for stacks and your RTP does not shift.",
   "markov-stationary", "The chain settles on the base distribution, whatever the stickiness.",
   '''import { sticky, stationary } from "@open-rgs/markov";

stationary(sticky(BASE, 0.9));'''),

  ("How tall are the stacks",
   "Run length is what stickiness is actually tuned against, and guessing it from spin footage is slow. It is a geometric distribution, so it has a closed form.",
   "markov-runs", "High stickiness produces natural stacks, the one thing a strip gave you.",
   '''import { meanRunLength, transitions } from "@open-rgs/markov";

meanRunLength(BASE, 0.35, "HIGH");

transitions({ A: { A: 75, B: 25 }, B: { A: 75, B: 25 } });'''),
 ]),

("recipes", "Recipes", "Named boards",
 "Every board comes from exactly one declared recipe.",
 [
  ("A mixture, not a decoration",
   "Draw a board and then stamp extra symbols on it and the real distribution stops matching the one RTP was computed from, silently. A mixture avoids that: RTP is a sum over recipes, each independently measurable.",
   "recipes-mix", "One recipe chosen per board, at its declared probability.",
   '''import { recipes } from "@open-rgs/recipes";

const board = recipes([
  { name: "base",        p: 0.94, draw: reels },
  { name: "two-scatter", p: 0.05, draw: tease },
  { name: "high-stack",  p: 0.01, draw: stacked },
]);

const { grid, recipe } = board(host.rng_next);'''),

  ("A tease is a real draw",
   "The tease board goes through the pay evaluator honestly. You bias which boards appear, at a rate you wrote down, and never fake an outcome - which is also what keeps near-miss behaviour on the right side of the rules.",
   "recipes-tease", "A tease is a real draw that goes through the pay evaluator honestly.",
   '''import { place, stack } from "@open-rgs/recipes";
import { randomN, cols } from "@open-rgs/selectors";

const tease = place(2, "SC", randomN(2, cols([0, 1])), reels);

board.probabilityOf("two-scatter");'''),

  ("Placement building blocks",
   "A recipe is written as a pipeline rather than a special case buried inside the base draw. Probabilities must sum to 1: a mixture summing to 0.98 misprices every spin by an amount nobody will notice.",
   "recipes-place", "place() writes symbols into the cells a selector picked.",
   '''import { placeAt, placeDrawn, fixed } from "@open-rgs/recipes";

placeAt("WILD", cols([2]), reels);
placeDrawn(3, highs, randomN(3), reels);
stack("HIGH", 2, reels);'''),
 ]),

("paytable", "Paytable", "What things are worth",
 "One shared notion of payout, wild and scatter.",
 [
  ("One table, four evaluators",
   "Lines, ways, anywhere and cluster all read this, so a symbol means the same thing in each. When each carried its own idea of a wild, a game using two of them could disagree with itself and the two RTPs would quietly differ.",
   "paytable-wild", "A wild substitutes for anything except a scatter.",
   '''import { paytable, substitutes } from "@open-rgs/paytable";

const PAY   = paytable({ HIGH: { 3: 10, 4: 50, 5: 200 } });
const roles = { wilds: ["WILD"], scatters: ["SC"] };

substitutes("WILD", "HIGH", roles);
substitutes("WILD", "SC",   roles);'''),

  ("Bands for cluster games",
   "Cluster games pay by size range while a paytable stores exact counts, so there is never interpolation to reason about. bands() bridges the two.",
   "paytable-bands", "Size ranges expanded into the exact counts a paytable stores.",
   '''import { bands } from "@open-rgs/paytable";

const CLUSTER = paytable(bands({
  HIGH: [[5, 2], [9, 6], [12, 22], [15, 90]],
}, 49));'''),

  ("Watch the top band",
   "The top band is open-ended: it runs from its start all the way to maxCount. On a five-reel grid seven scatters is impossible, so the intuition is that it is a lottery ticket. On 49 cells it is not.",
   "paytable-topband", "The top band runs all the way to maxCount.",
   '''PAY.maxCount("HIGH");
PAY.best("HIGH");'''),
 ]),

("pay-lines", "Pay-lines", "Runs along a line",
 "Longest run, paid once.",
 [
  ("Anchored, and paid once",
   "A payline is a row index per column. Evaluation walks it left to right and pays the longest qualifying run - paying every prefix as well roughly doubles a game's RTP.",
   "pay-lines-run", "A run must be anchored at the leftmost reel.",
   '''import { evalLines, rowLines } from "@open-rgs/pay-lines";
import { totalMultiplier } from "@open-rgs/paytable";

const LINES = rowLines(5, 3);

const wins = evalLines(grid, LINES, PAY, { roles });
totalMultiplier(wins);'''),

  ("A wild-opening run is ambiguous",
   "It can be read as the wild's own symbol or as whatever it substitutes for further along. The convention is to pay whichever is worth more; reading it only as the wild silently underpays the best board in the game.",
   "pay-lines-wildopen", "The reading worth more is the one that pays.",
   ''''''),

  ("Both ways compete",
   "A game paying from either end evaluates both directions and keeps the better one. Paying both would double-count a run that spans the whole grid.",
   "pay-lines-bothways", "The two directions compete rather than accumulate.",
   '''const wins = evalLines(grid, LINES, PAY, { roles, bothWays: true });

evalLine(grid, [2, 2, 2, 2, 2], PAY, { roles });'''),
 ]),

("pay-ways", "Pay-ways", "Consecutive columns",
 "Paid by the product of per-column counts.",
 [
  ("Counting ways",
   "No paylines. A symbol pays if it appears on consecutive columns from the first reel, and the payout is multiplied by the number of distinct paths through them.",
   "pay-ways-cols", "Two on the first reel, one on the second, three on the third: six ways.",
   '''import { evalWays, totalWays } from "@open-rgs/pay-ways";

const wins = evalWays(grid, PAY, { roles });

wins[0].ways;
totalWays(grid);'''),

  ("A gap ends the run",
   "Counting every column the symbol appears on, gap or not, inflates both the count and the ways multiplier. Ways games are dense, so this bug is far more expensive here than on lines.",
   "pay-ways-gap", "A gap ends the run. Counting past it inflates the multiplier.",
   '''evalWay(grid, "HIGH", PAY, { roles });'''),

  ("Variable heights need no change",
   "This never reads the shape. It counts actual matches per column, so a board whose reels drew different heights this spin works unchanged.",
   "pay-ways-heights", "On a multiways board the heights vary per spin, and this needs no change.",
   '''import { heights, multiwaysFillWeights } from "@open-rgs/multiways";

const H = heights({ 2: 20, 3: 25, 4: 25, 5: 15, 6: 10, 7: 5 }, 6);
const reels = multiwaysFillWeights(H, BASE);

evalWays(reels(host.rng_next), PAY, { roles });'''),
 ]),

("pay-anywhere", "Pay-anywhere", "Scatters",
 "Total count, position irrelevant.",
 [
  ("Counted anywhere",
   "The simplest evaluator and the one with the largest effect on a game's shape, because it is almost always what starts the feature - and feature frequency is usually the biggest single term in RTP.",
   "pay-anywhere-scatter", "Counted anywhere on the board, in any arrangement.",
   '''import { evalScatters, countAnywhere } from "@open-rgs/pay-anywhere";

const wins = evalScatters(grid, PAY, { roles });

countAnywhere(grid, "SC");'''),

  ("A wild never counts",
   "Scatter substitution would manufacture triggers, and the trigger rate you balanced would not be the one you shipped. Only literal matches count here.",
   "pay-anywhere-nowild", "A wild never counts. Substitution here would manufacture triggers.",
   '''countAnywhere(grid, "SC");'''),

  ("Triggering is not paying",
   "Plenty of games trigger on three scatters while paying nothing for them, and plenty pay for two without triggering. The two questions stay separate.",
   "pay-anywhere-trigger", "Triggering is a separate question from paying.",
   '''import { triggersOn, shortOfTrigger } from "@open-rgs/pay-anywhere";

triggersOn(grid, "SC", 3);
shortOfTrigger(grid, "SC", 3);'''),
 ]),

("pay-cluster", "Pay-cluster", "Connected groups",
 "A wild belongs to every cluster it touches.",
 [
  ("Orthogonal flood fill",
   "A win is a group of the same symbol connected up, down, left or right - never diagonally - paid by how many cells it holds.",
   "pay-cluster-flood", "A flood fill from each real occurrence, spreading through neighbours.",
   '''import { evalAllClusters, clustersOf } from "@open-rgs/pay-cluster";

const wins = evalAllClusters(grid, CLUSTER, { roles });

clustersOf(grid, "HIGH", roles);'''),

  ("Wilds are the whole difficulty",
   "A wild sitting between two clusters is legitimately part of both. So the fill runs per symbol and consumes only real matches - consume the wild for the first and the second silently shrinks by one, with nothing on the board looking wrong.",
   "pay-cluster-wild", "The outlined wild is counted in the teal group and the amber one.",
   ''''''),

  ("Never seeded from a wild",
   "Growing a cluster around a symbol that is not actually present would invent wins out of a lone wild. A wild-only region pays nothing: with no real symbol to be, there is no paytable row to read.",
   "pay-cluster-diag", "Orthogonal only. Diagonals do not connect.",
   '''import { largestCluster } from "@open-rgs/pay-cluster";

largestCluster(grid, "HIGH", roles);

evalAllClusters(allWilds, CLUSTER, { roles });'''),
 ]),

("cascade", "Cascade", "Tumbles",
 "Clear, fall, refill, repeat.",
 [
  ("Gravity is per column",
   "A short reel drops its symbols a shorter distance. Treating the board as a rectangle mixes symbols between columns - a bug that reads as a shuffle rather than a fall, and still looks plausible on screen.",
   "cascade-fall", "Winners clear, survivors fall, a fresh symbol drops in on top.",
   '''import { clear, collapse, refill, tumble } from "@open-rgs/cascade";

const next = tumble(grid, winningCells, (n) => symbols.pick(n()), host.rng_next);'''),

  ("The ladder applies per step",
   "It multiplies that step's own win, never the running total. Applying it to the total compounds across steps and inflates RTP badly.",
   "cascade-ladder", "The ladder climbs per step and applies to that step's own win.",
   '''import { runCascade } from "@open-rgs/cascade";

const run = runCascade(start, evaluate, pick, host.rng_next, {
  stepMultipliers: [1, 2, 3, 5, 8, 12],
  maxSteps: 30,
});

run.steps[1].paid;'''),

  ("The loop is bounded",
   "A refill can always produce another win, so in principle a cascade never ends. Unbounded, one unlucky spin hangs the process; the cap turns that into a finite, auditable round.",
   "cascade-bounded", "The loop is capped, because a refill can always win again.",
   '''run.truncated;'''),
 ]),

("holdwin", "Hold and win", "Respins",
 "A landing resets the counter.",
 [
  ("The cycle",
   "N coins on a base board trigger respins. Coins lock, and every new coin resets the counter rather than decrementing it. That single rule is what makes the feature feel alive - and why a cycle has no natural end, so the max-win cap is what makes the round finite.",
   "holdwin-meter", "Respins burn down, then a coin lands and the counter snaps back to full.",
   '''import { triggers, beginRespins, stepRespins, isCycleOver, settleRespins } from "@open-rgs/holdwin";

const CONFIG = { respins: 3, fullBoardAward: "GRAND" };

if (triggers(grid, 6)) {
  let s = beginRespins(grid, CONFIG);
  while (!isCycleOver(s)) s = stepRespins(s, landed, CONFIG);
}'''),

  ("Five mechanics, one shape",
   "Collector, payer, multiplier, upgrader and spawner are the same mechanism with different selectors. Adding &quot;collect only from the same column&quot; is a selector, not a new engine.",
   "holdwin-collect", "A collector absorbs the value of every coin it targets.",
   '''import { collector, payer, upgrader, cashCells, tierCells } from "@open-rgs/holdwin";

collector(cashCells(), JACKPOTS);
upgrader(tierCells(["MINI"]));
payer(5, coinCells());'''),

  ("Tiers resolve through one table",
   "A jackpot coin carries a tier, not a number, so retuning GRAND never means touching every coin. A collected coin is emptied rather than removed - it still fills the board but cannot be harvested twice.",
   "holdwin-full", "Filling the board pays the top tier.",
   '''import { mixedCoinSet, coin, settleRespins } from "@open-rgs/holdwin";

const JACKPOTS = { MINI: 8, MINOR: 20, MAJOR: 60, GRAND: 400 };

const COINS = mixedCoinSet(
  [{ item: coin(1), weight: 46 }, { item: coin(5), weight: 8 }],
  { MINI: 5, MINOR: 1.6, MAJOR: 0.35 },
);

settleRespins(state, CONFIG, JACKPOTS);'''),
 ]),

("multiways", "Multiways", "Variable reel heights",
 "Each reel draws its own height, every spin.",
 [
  ("Heights are the mechanic",
   "Each reel independently draws a height, and the ways available that spin are the product. Six reels at two to seven span 64 ways to 117,649. Because a shape is already a list of column heights, this needed almost no code.",
   "multiways-heights", "Reels grow and shrink independently, so the ways count moves with them.",
   '''import { heights, multiwaysFillWeights } from "@open-rgs/multiways";

const H = heights({ 2: 20, 3: 25, 4: 25, 5: 15, 6: 10, 7: 5 }, 6);

const reels = multiwaysFillWeights(H, { LOW: 55, HIGH: 12, WILD: 5 });'''),

  ("The marketing number",
   "Reel heights are drawn independently, so the expected board ways is the product of the per-reel expectations. Correlate the reels and that stops being true.",
   "multiways-product", "Ways is the product of the heights the spin drew.",
   '''import { expectedWays, minWays, maxWays } from "@open-rgs/multiways";

minWays(H);
maxWays(H);
expectedWays(H);'''),

  ("Do not rescale by ways",
   "A k-column win carries a multiplier scaling as h to the k, while the board scales as h to the reel count. Only a paytable weighted entirely on full-length runs tracks board ways; everything shorter scales slower, and short runs hold most of the expected value.",
   "pay-ways-cols", "pay-ways needs no change: it multiplies match counts, never heights.",
   '''import { expectedWaysPayout } from "@open-rgs/multiways";

expectedWaysPayout(H, 0.25, (k) => PAY.pay("HIGH", k));'''),
 ]),

("big-symbols", "Big symbols", "Blocks",
 "One symbol across a block of cells.",
 [
  ("Repeated cells, no overlay",
   "A big symbol is written as the same symbol across every cell it covers. No marker, no parallel geometry. That is what makes it work with every evaluator for free - and it matches what players are paid.",
   "big-counts", "A 2x2 wild really does act as four wilds.",
   '''import { placeBig } from "@open-rgs/big-symbols";

const g = placeBig(grid, { pos: { col: 1, row: 1 }, width: 2, height: 2 }, "WILD");'''),

  ("Fit is not obvious",
   "A 2x2 needs two adjacent columns that are both tall enough at those rows. On a multiways board where one reel drew a height of two, a block that fits everywhere else does not fit there.",
   "big-fit", "A block needs every column it covers to be tall enough.",
   '''import { fits, placements } from "@open-rgs/big-symbols";

fits(RAGGED, { col: 1, row: 2 }, 2, 2);
placements(RAGGED, 2, 2);'''),

  ("Refuse rather than clip",
   "A clipped 2x2 is a 2x1 pretending to be one: it pays less than the game promised, and by then it is just symbols, so nothing downstream can tell. Random placement returns the board unchanged when nothing fits, because a feature that cannot place is an outcome to price rather than a crash.",
   "grid-ragged", "On a ragged board a block that fits elsewhere may not fit here.",
   '''import { placeRandomBig, blocksOf } from "@open-rgs/big-symbols";

placeRandomBig(grid, "WILD", 3, 3, host.rng_next);

blocksOf(g, "WILD", [[2, 2], [3, 3]]);'''),
 ]),

("scatters", "Scatters", "Spawned as an event",
 "The trigger rate is a parameter, not an emergent property.",
 [
  ("Declared, not discovered",
   "With a natural scatter the trigger rate emerges from per-cell probability and grid size, and you tune it by guessing a weight and re-simulating. Draw the board with the scatter at weight zero and spawn instead, and the count distribution becomes the trigger rate.",
   "spawn-count", "The count distribution is declared, so the trigger rate is written down.",
   '''import { withScatters, oneInFor, probabilityOfAtLeast } from "@open-rgs/scatters";

const config = {
  symbol: "SC",
  count:  { 0: 9000, 1: 700, 2: 250, 3: 45, 4: 5 },
};

oneInFor(config, 3);
probabilityOfAtLeast(config, 3);'''),

  ("One per reel, and which reels",
   "At most one per reel is the genre norm, and it is what makes the count distribution exactly controllable. Excluded reels never receive one.",
   "spawn-onereel", "At most one per reel by default; excluded reels never receive one.",
   '''const config = {
  symbol:     "SC",
  count:      { 0: 9000, 1: 700, 2: 250, 3: 45, 4: 5 },
  reels:      [1, 2, 3],
  onePerReel: true,
};

const board = withScatters(reels, config);'''),

  ("Protected symbols stay",
   "A wild the player can see is about to pay must not be eaten. If protections leave too few legal cells, the spawn places what it can and reports both numbers - throwing would crash a legitimate spin, and silence would break the declared rate with nothing to notice it.",
   "spawn-protect", "Protected symbols are never eaten - a wild about to pay stays put.",
   '''import { spawnOn, assertFeasible } from "@open-rgs/scatters";

const result = spawnOn(grid, { ...config, protects: ["WILD"] }, host.rng_next);

result.wanted;
result.spawned;

assertFeasible(config, 5);'''),
 ]),
]

PAGE = '''---
import BaseLayout from "../../layouts/BaseLayout.astro";
import Anim from "../../components/Anim.astro";
import Code from "../../components/Code.astro";
---

<BaseLayout
  title="@open-rgs/{slug}  - {tag}"
  description="{name}: {lede}"
>
  <main>
    <p class="dim"><a href="/extension">All extensions</a></p>
    <h1>@open-rgs/{slug}</h1>

    <p class="lede">{lede}</p>

{body}
  </main>
</BaseLayout>'''

SECTION = '''    <h2 data-section="&sect; {n}">{heading}</h2>

    <p>{prose}</p>

    <Anim kind="{kind}" caption="{caption}" />

    <Code code={{`{code}`}} />'''

for slug, name, tag, lede, sections in LIBS:
    body = "".join(
        SECTION.format(n=i + 1, heading=h, prose=p, kind=k, caption=c, code=code)
        for i, (h, p, k, c, code) in enumerate(sections))
    OUT.joinpath(f"{slug}.astro").write_text(
        PAGE.format(slug=slug, name=name, tag=tag, lede=lede, body=body))

rows = "\n".join(
    f'      <li><a href="/extension/{s}">@open-rgs/{s}</a>  - <span class="dim">{l}</span></li>'
    for s, n, t, l, _ in LIBS)
OUT.joinpath("_rows.html").write_text(rows)
print(f"{len(LIBS)} pages, {sum(len(s) for *_, s in LIBS)} examples")
