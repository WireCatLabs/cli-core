### Added

- **A content write asks once.** `ContentWriteOptions.confirmed` carries the keys the `posts` command asked the owner
  about (those at level `ask`), and `contentWriterFromManifest` hands them, with the call's own `api.<operation>` key
  when there are any, to its `write` as a fourth argument. A CLI passes them to
  `serviceApiWriter(...)(command, operation, input, { confirmed })`, so a terminal publish asks the owner once; a key
  the command did not ask (the publish key for a post published at the source since the last sync) is still asked,
  and `deny` or `readonly` still refuse.
- **`contentManifestFake` in `@wirecat/cli-core/content/testing`.** A content service in memory, built from a CLI's
  own source manifest and generated API, as `crmManifestFake` is for a CRM: the contract kits and the CLI's `sync` run
  over it without a hand-written fake of the service.

### Changed — may break callers

- **The content commands use the vocabulary's words**, so a CLI made from them passes `cli-dev lint` (it needs
  cli-base with the content words). A script that called the old names must change:

  | Before | Now |
  |---|---|
  | `authors list` | `users list` |
  | `terms list` | `tags list` |
  | `metrics show <post>` | `posts stats <post>` |
  | `posts schedule <post> --at <time>` | `posts publish <post> --at-time <time>` |
  | `posts list --since <day> --until <day>` | `posts list published:[<day> TO <day>]` (or `published:<day>`) |
  | `posts list term:<id>` | `posts list tag:<id>` |
  | `posts create\|update --body-file <path>` | `--text-file <path>` |
  | `posts create\|update --excerpt <text>` | `--description <text>` |
  | `posts create\|update --term <id>` (repeated) | `--tags <id,id>` |
  | `posts delete --force` | `posts delete --allow-delete` |

  `channels list`, `users list` and `tags list` take a query, which narrows by no field yet. The `posts.schedule` key
  is gone: scheduling checks `posts.publish`, as it did already. A config that still sets `posts.schedule` now holds
  an unknown key, so every command refuses to run and names the `config unset` that removes it.

### Fixed

- **A profile on its own site keeps the site in its account.** `tokenSessionCommand` with `site` remembers
  `<site>:<user id>`, the site as `--site` cleans it (host in lower case, no trailing slash), as bitrix24-cli keeps
  `<portal>:<user id>`. Each WordPress site numbers its users from 1, so two profiles on two sites shared one copy in
  the store, and a sync of one marked the other's posts deleted.
- **`posts list published:>…` leaves out a post published at that very second.** A strict start was read as `>=`.
- **`posts create|update --tags` with no ids is refused**, not taken as "remove every tag".
- **`contentManifestFake` puts a list where the call's own `items` says**, wraps a `get` answer at `get.items`, and
  matches a route from the server's path only, so `/posts` no longer answers `/users/5/posts`.
