### Added

- **`readStream` on the SFTP client reads a file of any size in pieces.** It gives the file in order, 64 KiB at a
  time with about a megabyte read ahead, so a Master.csv of gigabytes or a recording for ffmpeg is never held whole.
  `maxBytes` is optional. A connection that breaks halfway is opened again and the read goes on where it stopped,
  once the bytes just before that point read the same; a file replaced meanwhile is refused (`sftp.file-changed`).
  Host-key pinning and the read-only rules are the same as for `readFile`. Each attempt is an `sftp.stream` event.
  See [SFTP](../docs/sftp.md#read).
- **`openSshTunnel` reaches a database that listens only on its own server** (a FreePBX CDR database) with no
  `ssh -L` by hand. It signs in with the pinned host key, only forwards (no shell, no command, no SFTP), and opens no
  port on this computer: `connect(host, port)` answers a stream shaped as a socket, which `pg` and `mysql2` take as
  their `stream`. `close()` ends it at the end of the run. Its events are `ssh.connect` and `ssh.forward`
  (`transport: "ssh"`), with no forwarded address. See
  [SFTP, "A tunnel to a database behind the server"](../docs/sftp.md#a-tunnel-to-a-database-behind-the-server).
- **`@wirecat/cli-core/sql`: a read-only MySQL, MariaDB and PostgreSQL reader for a host's own table.**
  `openSqlReader` opens a read-only session with TLS checked and connect and query timeouts, keeps a time without a
  zone as its text, reads in pages by the last row's key (or by offset), checks every name as an identifier and
  sends every value as a parameter, takes a tunnel's stream as `socket`, and maps driver errors to reasons without
  their text (`db.refused`, `db.no-table`, `db.no-select`, `db.read-only`…; `sqlFailure` for a host's own code).
  `mysql2` and `pg` are optional peers, loaded on first use. It is the generic half of pbx's CDR reader; the
  schema mapping stays in pbx. See [SQL](../docs/sql.md).

### Changed — may break callers

- **`SftpClient` has `readStream`.** A fake typed as `SftpClient` in a host's tests adds it.
