### Added

- **`failedAnswer`: a service's refusal inside an HTTP 200 answer.** Slack's Web API answers every failure with 200
  and `{"ok": false, "error": …}`, so its failures printed as successes. A CLI now passes
  `failedAnswer(answer, operation)` to `serviceApiCommand`, `serviceApiCall` or `httpApiExecutor`; the error it
  returns for a 2xx answer of an HTTP operation is the run's error, for a write too, since the service said it did
  nothing. `failure` is still asked only for a non-2xx answer and a GraphQL `errors[]`.
