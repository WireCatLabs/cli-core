### Added

- **`stages suggest` proposes a base stage for every unconfirmed CRM stage with the AI model** chosen with
  `models ai set`. It asks only about stages with a real choice: a won or lost stage usually has one base stage of its
  outcome and keeps the store's suggestion. The answers are suggestions the owner confirms at once with
  `stages confirm --all`. Without a model it sends nothing and says how to choose one (`ai.not-set`).
- **An agent can do the same work without a paid call.** `stages suggest --dry-run` prints the stages, the base
  stages to choose from and the answer's shape as JSON; `stages suggest --text-file -` records the agent's answer as
  suggestions and lists what it skipped. An agent's run never sends the stages to the model (`stage.model-agent`).

### Fixed

- **A sync no longer replaces a suggestion an agent or a model made.** It guessed again by position for every
  unconfirmed stage of the pipelines it saved; now it guesses only for a stage that has no suggestion yet.
