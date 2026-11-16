### Added

- **An agent's link of two people merges at once on strong evidence** (`people.agentLink`). The store
  decides, never the agent's word: one value only these two people hold, a mobile number or a personal address, from
  two different sources, and for a phone at least one that keeps its user's own number (a messenger account or a
  call's number). Anything weaker, the owner's own person, a pair the owner rejected, or `apply: false` opens a
  proposal as before, whose payload now says why it is not strong (`strength`). The merge is recorded as an
  `identity_link` the agent decided, with the evidence, the reason and the run, and `undoMerge` gives both people back.
- **`people.linkEvidence(pairs)`** answers what each pair of people shares and whether it is strong, reading the store
  once; **`people.agentMerges()`** lists the agents' merges still in place; **`people.merges()`** names the agent, run,
  reason and evidence of an agent's merge (`agent`).
- **`commandRunId()`** (`@wirecat/cli-core/cli`) gives the id `runs show` takes for the command under way, so a write
  can name the run that made it.
