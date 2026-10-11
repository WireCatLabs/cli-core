# Backlog

Open work only. A finished item is deleted; its record is the merged pull request.

- **One message search without a language switch** — Lucene syntax with legacy's forgiving matching,
  matchers run in parallel, merged and ranked against the query, each hit labelled with how it matched;
  removes `--language legacy`. Ranking test set and an owner-approved plan come first:
  [combined-search-handoff.md](combined-search-handoff.md).
- **Messenger feature gaps** — albums, archiving, typing and location, MAX cloud password and video
  notes. Proposed, not claimed: [messenger-feature-gaps.md](messenger-feature-gaps.md).
- **Chat briefs and news digests** — decisions, requests and open questions per chat for a time window,
  and a cited digest of selected news feeds, prepared for the owner's agent. Not designed beyond a
  proposal; needs the owner's scope before a plan.
- **Mail embedding: cut per email again?** Measured in [bench/mail-quality](../../bench/mail-quality/README.md):
  thread pieces find the right email for 24–25 of 43 queries, per-email pieces for 39–40, and both find the
  right thread equally often. Waiting for the owner's decision. Not measured yet: a model-based line
  classifier for cleaning, and a run on the owner's own mailbox, which would stay in cli-private.
