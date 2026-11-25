### Fixed

- **A long sync stays fast as the chat grows.** Each saved message looked through the whole chat for replies
  waiting for it as their thread's root, so a page of 100 took 78 ms at 10,000 stored messages and 919 ms at 90,000.
  That search now runs once per page (tg-cli [#917](https://github.com/WireCatLabs/tg-cli/issues/917)).
