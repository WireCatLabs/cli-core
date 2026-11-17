### Added

- **The `api` group and `serviceApiCall` send a GraphQL operation** of a manifest that cli-base 0.115.0 generates
  from a schema. Each call is one POST of the document `graphqlDocument` builds, never sent again on a redirect.
  The variables are `--body` as one object with each flag over it, read by its schema: digits as written, `true` or
  `false`, JSON for an input object. A variable the operation does not declare, or a required one left out, is
  refused before anything is sent. The flags of a GraphQL operation are its body and stay out of the run's files.
- **`errors[]` is a failure even at HTTP 200.** A CLI's own `failure` names it first; else its `extensions.code`
  does, repeated only when it is a plain constant, never the service's message. A write is `outcome_unknown` unless
  the code says nothing ran and no data came back. The answer is `data.<field>`; `--all` pages by `pageInfo`.
- **`ApiCommandInput.selection`** gives a source a deeper selection than the generated one. `api list` and the run
  record name a GraphQL operation as `POST` `query/issues`.

### Changed — may break callers

- **cli-core needs `@wirecat/cli-base` 0.115.0 or later**, whose manifest has the `graphql` binding.
