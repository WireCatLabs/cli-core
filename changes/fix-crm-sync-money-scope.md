### Changed — may break callers

- **A chosen `unassigned` list replaces your own user in scope `mine`.** With `unassigned` set, a sync copies only
  those users' deals and leads, and your own user's only when the list names it, as bitrix24-cli already reads them.
  Before, cli-core kept your own deals while bitrix24-cli no longer sent their changes, so they went stale and were
  later counted as deleted on the CRM. Now they leave the copy as out of scope, or, under the default `mine`, the
  narrowing is held until you set `scope`. To keep your own deals as well, add your own user id to `unassigned`.
  `store status` no longer lists your own user under `applied.users` while `unassigned` names anyone. While a
  narrowing is held, the daily id check marks deleted only deals inside the scope.
- **A CRM deal whose amount the store cannot hold is kept, with no amount, and says why.** Before, a deal in a
  currency the store has no scale for (BRL, MXN, SGD and others), with more decimals than its currency has, below
  zero or too large, was left out of `deals list`, the funnel and the totals, with `crm.item-invalid` in the sync
  answer. Now the deal is stored with `amount` and `currency` empty, and the sync answer names it as
  `crm.amount-unkept`. Its `provider_metadata.amount_note` ("Amount not kept") is WireCat's own note, not a CRM
  field: what the CRM had and why it was not kept.

### Fixed

- **Under scope `mine`, a contact assigned to a user in scope is no longer removed when it is on no deal.** A source
  that sends the contact's `assignee` keeps such a contact through the cleanup after a narrowing or `sync --rescan`.
- **A held narrowing on a small copy is no longer undone by the same run's list of ids.** While the narrowing waits
  for you, the id check marks deleted only deals inside the scope, so no deal outside it is marked deleted.
- **A deal in a new stage, skipped because the run's budget ran out before the pipelines were read again, is read
  again.** The next run reads that page again instead of moving past it.
