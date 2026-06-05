---
"@open-rgs/simulator": minor
---

feat(simulator): play-flow graph - SEE how interactive rounds were played

A single RTP number says how much, not how. `simulate({ flow })` now records a
**play-flow graph**: a little Markov chain of how complex rounds were actually
played - decision nodes, the action taken, and the transition probability. It's
attached to `report.flow` and rendered by `mdReport` as a **Mermaid flowchart**
(reads like a Markov chain; renders inline on GitHub and the docs site) plus a
transition table.

Pass `flow: true` to label nodes by `awaiting.type`, or `flow: { label }` to
bucket nodes from the PUBLIC context (`awaiting` + `ops`) - never the opaque
state, so the view can't depend on hidden info. Off by default (zero overhead).

New exports: `createFlowRecorder`, `flowToMermaid`, `flowToMarkovTable`,
`FlowGraph`, `FlowEdge`, `FlowContext`, `FlowLabel`. The goal: make interactive
(complex / options) game math easy to eyeball and test - run it, look at the
chart, check the transitions match intent. See `examples/gamble-slot` (the
gamble-or-collect ladder visualized as a Markov chain).
