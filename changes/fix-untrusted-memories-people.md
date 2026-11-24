### Fixed

- **Memories, facts and the names a provider shows for a document's accounts are marked untrusted for a scheduled
  agent.** In a run locked read-only with a mark, `memories list|show|search` and `facts list|show` mark each one's
  `text`, `identities list` marks an account's `name` and its person's `name`, and `documents context` marks the same
  in its `memories`, `facts` and `people`. A model's memory repeats the words of whoever wrote the document, so an
  instruction planted there would reach the agent unmarked. Elsewhere the answers are unchanged. A CLI with its own
  copies of these commands wraps them with the new `KNOWLEDGE_UNTRUSTED` and `IDENTITY_UNTRUSTED` from
  `@wirecat/cli-core/documents/cli` ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md)).
- **`memories search` in a documents CLI finds a memory added with `memories add`.** The search reads its index
  read-only and only a writable open builds it, so a new memory stayed unfound. Adding one now indexes it.
