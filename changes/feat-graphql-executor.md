### Added

- **The `api` group and `serviceApiCall` send a GraphQL operation** of a manifest that cli-base 0.115.0 generates
  from a schema. Each call is one POST of the document `graphqlDocument` builds; the variables are `--body` as one
  object with each flag over it, read by its schema (a number, true or false, JSON for an input object), and a name
  the operation does not declare is refused before anything is sent. `errors[]` is a failure even at HTTP 200, named
  by its `extensions.code` and never by the service's message; the answer is `data.<field>`. `--all` pages by
  `pageInfo`. `ApiCommandInput.selection` gives a source a deeper selection than the generated one.

### Changed — may break callers

- **cli-core needs `@wirecat/cli-base` 0.115.0 or later**, whose manifest has the `graphql` binding.
