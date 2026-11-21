### Fixed

- **`session` help names the sign-in the CLI keeps,** as its prompt does: "application password" for a WordPress
  CLI, "API token" when the CLI names none, "password" for a sign-in with `--login`. It said "token" for all.
  A CLI's generated command pages change with it at its next bump.
- **`api` help names what the commands were made from.** `serviceApiCommand` takes `spec`, such as
  "its index at /wp-json"; left out, it is still "its OpenAPI document", or "its GraphQL schema" when every
  operation is GraphQL.
