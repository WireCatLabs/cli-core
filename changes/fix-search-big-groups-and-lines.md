### Fixed

- **A big group no longer hides its answers behind its own size.** When one group held most of the candidates of a
  search across chats, its 20th best was nearly as close as its best, so nothing in it ranked high. Such a group (100
  or more of the 500 candidates) is now measured against its 100th best, and its entries past the usual 20 come after
  every other chat's, so private dialogs keep their places.
- **A hit's lines show the message after the one that asks.** An answer rarely repeats the question's words, so the
  line after the best match on them is shown too, and the question's own words count twice against a made-up answer's
  (`--like`) when lines are picked.
- **A hit's lines show a reply that sits outside its chunk.** A later answer to a message of the chunk is often put in
  another chunk, so the best such reply (by the query's words, else the oldest) is shown after the hit's lines, one per
  hit.
- **The owner's block keeps a conversation the named-chat step pushed off the page.** Its chunk was left out of the
  block because the list showed that conversation, and then the named chat's hits pushed it out of the list.
