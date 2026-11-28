### Changed — may break callers

- **memo's ids in the store take the name `wcat` (store version 79, `minCompatible` 79).** memo becomes `wcat`
  ([plan](https://github.com/WireCatLabs/cli-core/pull/3443), owner's rulings of 28.11.2026). The mailbox of mail
  sent to many is `wcat:bulk` (`bulkBox`, was `memo:bulk`), an envelope rule's mailbox is `wcat:envelope:<kind>:<value>`
  (`envelopeBox`, was `memo:envelope:…`), and the scan's rule bot is `wcat-scan` (`SCAN_BOT`, was `memo-scan`).
- **The first build that opens the store runs version 79.** It rewrites, in one transaction, whole values only:
  `mailboxes.external_id` (`memo:bulk`, `memo:envelope:…`), `bots.name` (`memo-scan`, `memo-mcp`, `memo-findings`,
  `memo-mail-findings` become `wcat-scan`, `wcat-mcp`, `wcat-findings`, `wcat-mail-findings`, and `memo-reader`
  becomes `files-reader`), the same handles in `mail_sort_rules.decided_by`, `memo` as the tool that saved a template
  (`templates.updated_by`, `templates_history.saved_by`) becomes `wcat`, and the `memo` client in the store's
  client list becomes `wcat`. Every reference to a bot is by its id, so authors, proposers and deciders follow. A new
  name already taken keeps both rows, and the store still opens. Labels written as history (provenance, reasons,
  decision notes in `metadata`, import batch ids) keep the name they were written with.
- **What breaks: every WireCat CLI must move to cli-core 3.0 on the same day.** Once one CLI on this cli-core opens
  the store, every build before version 79 refuses it ("written by a newer version (schema 79, needs at least 79; this
  one speaks 78)"), so it can never write a second `memo:bulk` box beside `wcat:bulk`. Release each CLI on cli-core
  3.0 in the same run, or its users are locked out until they run `<cli> upgrade`. Code that names `memo:bulk`,
  `memo:envelope:…` or a `memo-*` bot (cli-memo's `AGENT`, `READER_BOT`, its findings bots and its tests) moves to
  the new names: the old ones no longer match a row. Before the migration the store copies `bots`, `mail_sort_rules`,
  `mailboxes`, `store_settings`, `templates` and `templates_history` into `backups/` beside it, and
  `store restore <copy>` takes it back to version 78.
