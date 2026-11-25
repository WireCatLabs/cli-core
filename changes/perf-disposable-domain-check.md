### Fixed

- **Scoring mail senders no longer rebuilds the throwaway-domain list for each sender.** The spam score
  (`scoreGroup`) and the organizations from mail domains now share one set built on first use
  (`isDisposableDomain`). Scoring 20,000 senders took about 7 s and now takes about 0.2 s.
