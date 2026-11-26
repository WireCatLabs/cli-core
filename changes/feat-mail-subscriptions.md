### Added

- **Subscriptions: `store.mail.subscriptions`** (experimental). Broadcast mail grouped by `List-Id`, else by its
  sender (`bot:<id>`, `person:<id>` or `address:<address>`), newest group first, grouped, counted and paged in
  SQL (`limit`, default 100, and `offset`; `accountIds`, `since`, `until` and `types` narrow it). Each group gives its
  `key`, `listId`, `name`, the `sender` ref and `address` of its newest email, its mail count, that `newest` email and
  `unsubscribe`: the `https` and `mailto` targets and `oneClick` from its newest email that names one, or `null`.
  Nothing is unsubscribed. A store opened read-only works types out in memory, as the type filters do.
- **List-Unsubscribe targets are kept.** Mail stored in full keeps `list-unsubscribe-https` and
  `list-unsubscribe-mailto` in `emails.headers`, only when the From domain's DKIM signature that Gmail passed covers
  `List-Unsubscribe`. `list-unsubscribe` stays `true` whenever the field is present, and `list-unsubscribe-post` is
  kept as before. Mail stored earlier has no target until it is read again. No store version.
- **`people.listBots` filters by what a bot sends:** `sends` takes `alerts` (`security`, `system_alert`,
  `account_notice`), `receipts` (`order`, `bill`, `shipping`), `newsletters`, `marketing` (`promotion`) and
  `messenger` (a bot with an account in a messenger), any of them, in SQL. `BOT_SENDS` and `BotSends` are exported
  from `@wirecat/cli-core/store` and `@wirecat/cli-core/store/areas` (experimental), so memo and Desktop read one map.
  An unknown name is refused with `sender-bot.unknown-sends`.
