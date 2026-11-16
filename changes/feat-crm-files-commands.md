### Added

- **`files list`, `files download` and `files sync` in every CRM CLI** whose adapter has `files`
  (`addCrmCommands(program, { files: true })`). `files list --deal|--lead|--person|--organization <id>` reads a
  record's files live; `files download <id>` saves one under the state folder (folders 700, file 600) or `--dir`, at
  most 100 MB unless `--max-size` (up to 2048), and reads its text; `files sync` prefetches the files of your own deals
  and leads changed in the last `files.days`, within per-run limits, and goes on where it stopped. A colleague's record
  counts toward the day's limit of 100.
- **CRM file limits** as owner-only store settings `crm.<provider>:<account>.files.max_files`, `max_file_mb`,
  `max_run_mb`, `run_minutes`, `days` and `max_total_mb`; a value outside its range is refused. The account's folder
  is kept under `max_total_mb` by dropping the oldest files whose text is kept.
- **`search all` finds the text of downloaded CRM files** (`crm_file` hits, also under `--only crm`): a limited profile
  only those of records assigned to it, in the CRM CLI's and in memo's and tg's `search all` alike.
- **`fetchCrmFile`** for adapters: a file link fetched over https from the account's own hosts only, never naming the
  link in an error; **`crmFilesContract`** in `@wirecat/cli-core/crm/testing`.

### Changed — may break callers

- **memo's, tg's and the MCP's `search all` apply each CRM copy's viewer rule to deals and leads too**: a non-admin
  copy's colleagues' deals no longer show there, as they never did in the CRM CLI.
