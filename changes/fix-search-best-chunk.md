### Fixed

- **`search conversations --like` shows the part of a huge conversation that answers the question.** A conversation of
  more than 50 chunks holds text near any question, so its nearest chunk was often about something else. With a
  made-up reply, such a hit now shows the chunk that ranks best by meaning (to the question and the reply together)
  and by the words of both that are rare inside that conversation. Without `--like` nothing changes.
