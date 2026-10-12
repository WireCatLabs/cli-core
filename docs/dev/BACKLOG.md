# Backlog

Open work only. A finished item is deleted; its record is the merged pull request.

- **One message search without a language switch** — Lucene syntax with legacy's forgiving matching,
  matchers run in parallel, merged and ranked against the query, each hit labelled with how it matched;
  removes `--language legacy`. Ranking test set and an owner-approved plan come first:
  [combined-search-handoff.md](combined-search-handoff.md). Approved plan for the narrow first step (B):
  [typo-search-default-plan.md](typo-search-default-plan.md).
- **Messenger feature gaps** — albums, archiving, typing and location, MAX cloud password and video
  notes. Proposed, not claimed: [messenger-feature-gaps.md](messenger-feature-gaps.md).
- **Chat briefs and news digests** — decisions, requests and open questions per chat for a time window,
  and a cited digest of selected news feeds, prepared for the owner's agent. Not designed beyond a
  proposal; needs the owner's scope before a plan.
- **Mail embedding: what is not measured yet** — a model-based line classifier for cleaning, and a run of
  [bench/mail-quality](../../bench/mail-quality/README.md) on the owner's own mailbox, which would stay in
  cli-private.
- **Google Drive documents in the one store** — drive-cli writes into the shared store so `search all`
  finds Drive documents; approved, not built: [drive-in-store-plan.md](drive-in-store-plan.md).
- **Documents linked in a chat** — `chats documents list <chat>` in tg and max, with the message →
  document link written by drive's `sync`; approved, not built: [chat-documents-plan.md](chat-documents-plan.md).
