### Fixed

- **A CRM deal whose amount the store cannot hold is kept, with no amount, and says why.** Before, a deal in a
  currency the store has no scale for (BRL, MXN, SGD and others), or with more decimals than its currency has, was
  left out of `deals list`, the funnel and the totals. Now the deal is stored with `amount` and `currency` empty,
  `provider_metadata.amount_note` ("Amount not kept") says what the CRM had and why it was not kept, and the sync
  answer names it as `crm.amount-unkept`.
- **Under scope `mine`, a contact assigned to a user in scope is no longer removed when it is on no deal.** A source
  that sends the contact's `assignee` keeps such a contact through the cleanup after a narrowing or `sync --rescan`.
- **A held narrowing on a small copy is no longer undone by the same run's list of ids.** While the narrowing waits
  for the owner, the id pass does not run, so no deal outside the scope is marked deleted.
- **A deal in a new stage, skipped because the run's budget ran out before the pipelines were read again, is read
  again.** The next run reads that page again instead of moving past it.

### Changed — may break callers

- **A chosen `unassigned` list leaves the sign-in's own user out of scope `mine` unless it names that user** (the
  owner's ruling of 2026-11-12). Before, core always kept the own user's deals while bitrix24-cli dropped them, so
  they went stale and later counted as deleted on the CRM. Now they leave the copy as out of scope, or the narrowing
  is held under the default `mine`. To keep your own deals as well, add your own user id to `unassigned`.
