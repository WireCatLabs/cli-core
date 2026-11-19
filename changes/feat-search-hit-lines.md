### Added

- **`search conversations` shows what each hit says.** Every hit carries `lines`: up to three of its chunk's
  messages, the ones sharing most words with the query, as "sender: text" cut to 200 characters. An agent sees the
  answer in the first call instead of opening one hit after another; the owner's own messages are marked "(you)", and
  in the block of the owner's conversations they come first.
- **`search conversations --like <text>`**: a made-up one-sentence reply that would answer the query, searched by
  meaning beside the query and fused with it. It finds an answer worded unlike the question, in one call.
