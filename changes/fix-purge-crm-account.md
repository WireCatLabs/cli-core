### Fixed

- **Purging a CRM account deletes its deals, leads and pipelines.** `accounts.purge`, which `account remove
  --delete-data` runs, failed on a synced CRM account (`FOREIGN KEY constraint failed`) because it left the account's
  deals, leads, pipelines and stages in place. It now deletes them with their stage history, tags, aliases,
  attachments and links, and the link history the account's removed links left. A lead or an order of another account
  that names one of these deals keeps its row and loses only that link.
