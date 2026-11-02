# Changelog

## 1.0.0

- Investigations as co-pilot work (docs/swarm/SWARM.md, phase 6):
  - **`add_lead`**: a lead is kept with its evidence, each piece hashed, in the harness's own queue.
  - **`leads`**: the queue, ranked.
  - **`decide_lead`**: only the person decides a lead. It is refused where nobody can be asked.
  - **The `coverage` gate** over the checklist.
  - **The `investigation` workflow.**
  - **The mandate** (`.harness/investigation-mandate.json`): written by the person. Swarm agents cannot write it.
