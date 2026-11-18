### Added

- **`search conversations` shows the owner's own conversations nearest in meaning in a block of their own**, up to 5
  that the hits left out: in JSON they follow the hits with `from_owner: true`, in text under «your own messages».
  The hits keep their order. A question about what the owner said or advised is often answered by a message a busy
  group ranks low; on a test store of 220,000 chunks the block showed the answer to 31 of 40 questions instead of
  24, for about 0.24 s more per query. Only the owner's chunks are scored, found by their messages.
