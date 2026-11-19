### Added

- **`mailInboxCommand`: a mail CLI's `inbox` sorts new mail with the shared AI model.** The threads that changed since
  its last run go to the model chosen with `models ai` (Anthropic, OpenAI or a local Ollama), with no agent. It puts
  each one under needs an answer, to read or can wait, with a one-line reason, then lists every sorted thread, those
  that need an answer first. It sends each thread's subject, senders and its 3 newest emails without quoted mail or
  the signature, at most 1500 characters each. Mail sent to many is not sent. `--max-messages` (40 by default) and
  `--max-tokens` (60000) limit a run, and the threads left wait for the next. A model outside this computer follows
  local only and `models chats`: under ask it needs `--yes`. An agent is refused (`mail.inbox-agent`), and
  `--offline` lists without calling the model. A thread the owner answered leaves the list on the next run. The
  verdicts are kept in the store, so a schedule can run it.
- **Mail `review` shows how `inbox` sorted each thread**, as `email.inbox` (`bucket` and `reason`, the reason marked
  untrusted).
