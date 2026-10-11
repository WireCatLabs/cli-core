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
- **Mail embedding: measure what works best** — mail is cut by thread with a 150-character overlap and
  greetings, sign-offs and re-quotes left out, chosen as common practice, not measured. Extend
  [bench/search-quality](../../bench/search-quality/README.md) with a synthetic mail corpus (reply-heavy
  threads, quotes, signatures, newsletters; en/ru/es) and labelled queries, and compare: per email vs per
  thread; piece size 600/1200/2000; overlap 0/150/300; cleaning off/rules/a model-based line classifier.
  Report recall@5, MRR, pieces and vectors, embedding time and store size. Committed numbers stay
  synthetic; a run on the owner's mailbox stays in cli-private.
