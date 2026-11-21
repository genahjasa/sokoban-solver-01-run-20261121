# Sokoban Solver — make.fun bounty entry

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Node.js](https://img.shields.io/badge/Node-22-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121):
one program answers all 5 instances of a set in a single run, in as few
pushes as possible.

## How it works

The generated levels are a 1-wide hallway with 1–4 rooms off it, and a box
pushed out of its room into the hallway can never come back — so every box
stays in its room and the push-optimal count P\* is the sum of the rooms'
optima. The solver therefore:

1. Splits the level into rooms (connected components of floor off the
   hallway row) and solves each room independently in **push space**
   (state = player square + sorted box squares, one cost per push).
2. Searches each room with **A\*** and an admissible heuristic: the min-cost
   assignment (Hungarian, brute-forced over ≤ 4 boxes) of boxes to goals on
   precomputed shortest-path floor distances — so a completed search returns
   the push-optimal count.
3. Canonicalises the player to the lowest square of its reachable region,
   collapsing states that differ only by where the player stands.
4. Prunes only **sound deadlocks**: dead squares (reverse-push reachability
   from the goals), permanently immobile boxes, and full 2×2 blocks of
   boxes/walls holding a non-goal box. Nothing solvable is ever pruned.
5. Requires the player to be able to walk back out of a room after solving
   it (except for the one room solved last, where no exit is needed).
6. Stitches the room solutions together with plain walks along the hallway.

Budgets are deterministic expansion caps, never the wall clock, so two
executions write byte-identical output. No randomness, no network, no
dependencies beyond Node's built-ins.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `$MAKEFUN_INPUT_DIR/<id>/level.txt` (default `/input`) and writes
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (default `/output`) for every
instance.

## Practice-set result

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

Practice score: **1,000,000** (whole set in ~1 s locally). Verified with the
kit's local grader (`node cli/makefun.mjs grade-local`).

Robustness: the same solver was also run on 8 freshly drawn sets from the
kit's own generator (40 unseen instances): every instance solved at P\*,
1,000,000 on each set, ~0.7–1.0 s per set.

## License

MIT — see [LICENSE](LICENSE).
