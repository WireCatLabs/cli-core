### Changed — may break callers

- **cli-core 2.0: agents are `agent`, sender bots are `bot:` (store version 78, `minCompatible` 78).** The owner's
  rulings of 25.11.2026 and 26.11.2026 (contact-kinds plan, open question 7). Until now `bot:<id>` and the pointer
  type `bot` named an agent of the `bots` table, and a sender bot was `sender-bot:<id>`. Now an agent is `agent:<id>`
  and `agent`, and a sender bot is `bot:<id>`.
- **What breaks for callers:**
  - The JSON output: the `type` of `author`, `created_by`, `confirmed_by` and `decided_by` (tasks, deals, facts, mail
    and meeting findings) and of every actor pair says `"agent"` where it said `"bot"`.
  - `Proposer` (stable): `{ type: "agent", id, name, kind, verified? }` replaces `{ type: "bot", … }`.
  - `parseReference`: `agent:<number>` gives `{ type: "agent" }`; `bot:<id>` gives `{ type: "bot" }`, a sender bot.
    `agent:` takes a number only, so an author's name such as `agent:claude` stays a name and `looksLikeReference`
    says no.
  - `SENDER_BOT_PREFIX` is `"bot:"`. Sender bot refs in output (`moveToBot`, `showBot`, `store.mail.subscriptions`
    `sender`, sorting rule effects) say `bot:<id>`.
  - Still read, never written: `sender-bot:<id>` parses as `bot:<id>`, and `moveToBot`, `moveToPerson`, `showBot`
    and the sorting rules take it. The `sender-bot.*` error reasons keep their names.
- **Every WireCat CLI must move to cli-core 2.0 together.** All of them pin an exact cli-core version and share one
  store file. The first 2.0 build that opens the store runs version 78, which rewrites the stored values: every
  `*_type` pair in the 36 tables that have one, `links.target_text` and `links.metadata.gone`, `record_relations`
  refs, `proposed_actions.payload` (`from`, `to`, `ref`), `document_annotation_transfers.reference_map`, and
  `mail_sort_effects` (`sender-bot:` to `bot:`). After that, a 1.x build refuses the store with "the message store
  was written by a newer version (schema 78, needs at least 78 …)" (`configuration_error`), because it would read a
  sender bot's `bot:` as an agent and would keep writing agents as `bot`. So upgrade every installed CLI and WireCat
  Desktop the same day, and migrate with `serve`, `mcp` and syncs stopped. The migration writes a rollback copy
  first; without one it refuses, as since version 73.
- **Migration for API users:**
  - Match `type === "agent"` where you matched `type === "bot"` for an agent (actors, `Proposer`, output schemas).
  - Build a sender bot ref from `SENDER_BOT_PREFIX` (`bot:`) instead of the literal `sender-bot:`.
  - Pass a ref you read from older files or user input through `senderBotRef` (from `@wirecat/cli-core/store`): it
    turns `sender-bot:<id>` into `bot:<id>` and leaves any other text as it is. `OLD_SENDER_BOT_PREFIX` names the old
    form.
  - Unchanged: an author or decider `{ bot: name }` still holds an agent's name; `identity_links.method = 'bot'`,
    `identities.bot` and keyring `bot:<profile>` entries of a messenger's bot account are not agent refs.
