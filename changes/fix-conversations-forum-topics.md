### Fixed

- **A conversation never mixes the topics of a forum group.** A message's parent is always a message in its own topic
  or thread: a messenger reply into another topic, an agent's answer naming one, and the rules never link across. In a
  Telegram forum every message of a topic replies to the topic's first message, which has no topic itself; taken as a
  reply, it chained a whole topic, and through the first messages' sender every topic, into one conversation, and its
  chunks mixed topics. The linking-rules version is 6, so a chat built before reads as outdated and is rebuilt; a
  chunk whose text is unchanged keeps its vector. `conversations batches next` now asks the agent about a message
  whose only reply is into another topic.
