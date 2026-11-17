### Fixed

- **A conversation never mixes the topics of a forum group.** A message's parent is a message of its own topic or
  thread, or the thread's first message when that has text, as a WhatsApp community post its comments answer. In a
  Telegram forum every message of a topic replies to the topic's empty first message: taken as a reply, it chained a
  whole topic, and through those first messages' sender every topic, into one conversation, and its chunks mixed
  topics. A messenger reply into another topic, an agent's answer naming one, and the rules never link across. The
  linking-rules version is 6, so every chat built before reads as outdated and is rebuilt; a chunk whose text is
  unchanged keeps its vector. `conversations batches next` now asks the agent about a message whose only reply is
  one the build does not link.
