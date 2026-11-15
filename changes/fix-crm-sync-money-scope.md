### Fixed

- **A CRM deal whose amount the store cannot hold is kept, with no amount, and says why.** Before, a deal in a
  currency the store has no scale for (BRL, MXN, SGD and others), or with more decimals than its currency has, was
  left out of `deals list`, the funnel and the totals. Now the deal is stored with `amount` and `currency` empty,
  `provider_metadata.amount_note` ("Amount not kept") says what the CRM had and why it was not kept, and the sync
  answer names it as `crm.amount-unkept`.
