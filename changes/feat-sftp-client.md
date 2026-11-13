### Added

- **`@wirecat/cli-core/sftp`: a read-only SFTP client.** `openSftp({ host, username, auth, hostKey })` lists a
  folder, stats a path and reads a file into memory up to `maxBytes`; it has no method that writes. The server's host
  key must match the pinned `SHA256:` fingerprint before a credential is sent, and `sftpHostKey({ host })` gives the
  fingerprint a sign-in shows the owner to confirm. Each step has a deadline, the run's signal closes the connection,
  a dropped connection or a timeout is tried again over a new one with backoff, and each operation is a request in
  the run's events with its host and never a path. `ssh2` is an optional peer: a CLI that uses SFTP adds it to its
  own dependencies, and bundles it with `cli-dev bundle --external ssh2`. See [SFTP](../docs/sftp.md).
