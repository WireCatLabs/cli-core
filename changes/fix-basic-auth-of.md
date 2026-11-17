### Fixed

- **The `api` group tells a Basic scheme by its type, so a newer cli-base cannot change who signs.** cli-base #643
  makes `signInPlace` sign Basic, and cli-core told Basic apart by `signInPlace` answering `undefined`. With that
  cli-base, a call that offers Basic and a token would be signed with Basic, and a token without a user name would be
  sent in base64, not refused with "run session start --login <name>". Both rules now hold with either cli-base.
