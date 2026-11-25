### Fixed

- **A generated `api` command refuses an empty required argument before it sends anything.** `linear api issue-delete
  --id "" --yes` used to send the request, and Linear's answer left the write unconfirmed (exit 14,
  `outcome.unknown`). Now a required path, query or header parameter, or a required GraphQL variable from a flag
  or from `--body`, that is empty or only spaces stops the command with exit 2 (`validation_error`, reason `input.invalid`),
  naming the flag, and nothing is sent. An empty path parameter could otherwise reach another endpoint (`/posts/`).
  `serviceApiWriter` refuses the same for code. A bot API's body field is still sent empty: Telegram's `setWebhook`
  takes an empty `url` to remove the hook.
