### Changed — may break callers

- **Agents are `agent`, sender bots take `bot:` (store version 78, `minCompatible` 78).** The owner's ruling of
  25.11.2026 (contact-kinds plan, open question 7). An agent of the `bots` table was `bot:<id>` and pointer type `bot`;
  it is now `agent:<id>` and `agent` everywhere: the actor pairs (`author_type`, `confirmed_by_type`,
  `proposed_by_type`, `actor_type`, …), `Proposer` (`{ type: "agent", … }`), the `type` of `author`, `created_by`,
  `confirmed_by` and `decided_by` in the JSON output, and `parseReference`. `agent:` takes a number only, so an
  author's name such as `agent:claude` stays a name. A sender bot is `bot:<id>` (`SENDER_BOT_PREFIX`), and
  `sender-bot:<id>` still reads as one (`senderBotRef`, `parseReference`). Version 78 rewrites the stored values:
  every `*_type` pair, `links.target_text` and `links.metadata.gone`, `record_relations` refs,
  `proposed_actions.payload` (`from`, `to`, `ref`), `document_annotation_transfers.reference_map`, and
  `mail_sort_effects` (`sender-bot:` to `bot:`). It raises `minCompatible` to 78, so builds before it refuse the store
  once it has moved: they would read a sender bot's `bot:` as an agent. A caller that matches `type === "bot"` for an
  agent, or writes `sender-bot:`, changes to `agent` and `bot:`.
