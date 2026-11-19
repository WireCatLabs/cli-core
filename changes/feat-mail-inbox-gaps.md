### Added

- **mail `inbox` names each thread's sender and reports its run.** Each sorted thread carries `sender: { name,
  address }`, the newest email's sender who is not the owner (`null` for a thread sorted before). `meta.model_run`
  says what the run did: threads sent, sorted and left for the next run, the tokens the provider counted, the cost
  from the price list (null with no price) and the model and its endpoint. Needs cli-base's `meta.model_run`.
- **`chat-sending.ask` carries what would be sent as details.** mail `inbox`'s refusal adds `emails`, `threads`,
  `tokens`, `host`, `model` and `estimated_cost_usd`, so WireCat Desktop words the question in the owner's language.
  `chatSendingAskRefusal` takes them as an optional third argument.

### Fixed

- **mail `inbox` writes its one-line reason in the owner's language.** It followed each thread's language; it now
  uses the first of `owner_languages`, as the reports do.
