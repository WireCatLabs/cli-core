### Added

- **Mail search filters by mail type and reach.** `type:` takes one of the [mail types](../docs/dev/GLOSSARY.md#mail-types)
  and `reach:` takes `direct`, `group` or `broadcast`, in the query itself, so a page is never short:
  `memo search mail 'type:order OR type:bill'`, `memo search mail 'invoice -type:promotion reach:direct'`. A search
  that names either field first types the mail the store has not typed yet, 5,000 emails per write; on 100,000
  untyped emails the first such search after an upgrade takes seconds, later ones the usual milliseconds. A store
  opened read-only works the missing types out in memory for that search. tg and max refuse both as mail fields.
- **Email hits show their type and reach**: `email.mail_type` and `email.reach` in `--json`, and both on the hit's
  line in mail's text output. In the API they are `MailFields.mailType` and `MailFields.reach` (experimental).
- **`SENDER_BOT_PREFIX` is exported from `@wirecat/cli-core/store`, and `MAIL_TYPES`, `MailType`, `REACHES` and
  `Reach` from `@wirecat/cli-core/store/areas`** (experimental), so a CLI no longer copies them.
