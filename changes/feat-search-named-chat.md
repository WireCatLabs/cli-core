### Added

- **`search conversations` over every chat searches first the private chat a name in the query points to.** The name
  is learned from the messages, with no list of nicknames: the private chat that holds most of a word's uses, at least
  twice as many as any other private chat, and writes it with a capital letter nearly every time («Петька, привет»).
  That chat is searched without the name and its hits come first; `meta.named_chat` (`word`, `chat_id`) and a note
  say so. An ordinary word, spread over many chats in lower case, names none.
