# SFTP

`@wirecat/cli-core/sftp` reads files from an SFTP server: a PBX's call recordings, an export a system drops on a
server. It only reads. There is no method that writes, renames, deletes or changes a file.

## Set up

`ssh2` is an optional peer of cli-core, so a CLI that does not use SFTP neither installs nor loads it. A CLI that
uses SFTP adds it, keeps its native parts unbuilt, and leaves it out of the bundle:

```sh
pnpm add ssh2
```

```yaml
# pnpm-workspace.yaml: ssh2 runs in pure JavaScript without them
allowBuilds:
  cpu-features: false
  ssh2: false
```

```sh
cli-dev bundle --bin dist/bin/<cli>.js --external ssh2
```

Without `ssh2` installed, the first connection fails with `configuration_error` and reason `sftp.library-missing`.

## Pin the host key first

A connection never trusts a server it has not been told about. The owner confirms the server's key once, at sign-in,
and the CLI keeps the fingerprint with the profile:

```ts
import { sftpHostKey } from "@wirecat/cli-core/sftp"

const key = await sftpHostKey({ host: "pbx.example.com", port: 22, signal })
// { algorithm: "ssh-ed25519", fingerprint: "SHA256:Xb9…" }
```

`sftpHostKey` stops at the key exchange and sends no user name or password. The CLI shows the fingerprint and asks
the owner to compare it with the server's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server).
It saves the fingerprint only after the owner says yes.

## Read

```ts
import { openSftp } from "@wirecat/cli-core/sftp"

const sftp = await openSftp({
  host: "pbx.example.com",
  username: "recordings",
  auth: { password },                         // or { privateKey, passphrase }
  hostKey: "SHA256:Xb9…",                     // the fingerprint the owner confirmed
  signal: context.signal,                     // the run's signal
  events,                                     // the run's events; the current run when left out
})
context.trackCloseable(sftp)
try {
  const entries = await sftp.list("/var/spool/asterisk/monitor/2026/11/12")
  // [{ name: "out-….wav", kind: "file", size: 482316, modifiedAt: "2026-11-12T10:04:31.000Z" }, …]
  const one = await sftp.stat(`${folder}/${entries[0].name}`)
  const bytes = await sftp.readFile(`${folder}/${entries[0].name}`, { maxBytes: 200 * 1024 * 1024 })
} finally {
  await sftp.close()
}
```

- `list(path)` gives the folder's entries without `.` and `..`: `name`, `kind` (`file`, `directory`, `symlink`,
  `other`), `size` in bytes and `modifiedAt`. The server keeps whole seconds.
- `stat(path)` gives the same fields for one path; `name` is its last part.
- `readFile(path, { maxBytes })` gives the file's bytes. A file larger than `maxBytes` is refused before its first
  byte is read, and so is a file that grows past it while it is read.
- `close()` ends the connection. Pass the client to `trackCloseable`, so a timeout or Ctrl-C closes it too.

Secrets come from the caller, which keeps them in the keyring. They never reach an error, a log record or the run's
events.

## Time limits and retries

| | Default | Option |
|---|---|---|
| Connect, up to an open SFTP channel | 20 s | `connectTimeoutMs` |
| One `list` or `stat`; a `readFile` that receives no byte for this long | 30 s | `operationTimeoutMs` |
| Attempts | 3 | `retry` (cli-base's `RetryConfig`; `SFTP_RETRY` is the default) |

The run's signal stops every step and closes the connection. When the runner gives a reason (its deadline), that
reason is the error.

Every operation only reads, so a transient failure is tried again: a dropped or refused connection, a broken pipe, a
step past its deadline, and a server that disconnects as busy (SSH reasons 7, 10 and 12). Each retry opens a new
connection, after full-jitter backoff from 500 ms up to 5 s. A refused password or key, a host key mismatch, a missing
file and a denied path are never tried again. A read that fails halfway starts again from the first byte.

Waits go through the `sleep` option (cli-base's `SleepLike`), with reason `timeout` for a deadline and `retry` for a
backoff, so a test decides when time passes. A test connects through `socket`, a function that returns a stream
already connected to a server, such as ssh2's `Server` given the other end with `injectSocket`.

## Errors

| Code | Reason | When | Tried again |
|---|---|---|---|
| `configuration_error` | `sftp.host-key-missing` | no `hostKey` was given | no |
| `authentication_error` | `sftp.host-key-mismatch` | the server's key is not the pinned one; the message names the key it sent | no |
| `configuration_error` | `sftp.auth-missing` | neither a password nor a private key | no |
| `configuration_error` | `sftp.key-invalid` | the private key or its passphrase cannot be read | no |
| `configuration_error` | `sftp.library-missing` | `ssh2` is not installed | no |
| `authentication_error` | `auth.failed` | the server refused the user name and password or key | no |
| `not_found` | `file.not-found` | no such file or folder | no |
| `permission_error` | `file.denied` | the server denied access to the path | no |
| `validation_error` | `file.not-a-file` | `readFile` on a folder | no |
| `validation_error` | `sftp.too-large` | the file is over `maxBytes` (`details.max_bytes`) | no |
| `timeout` | `sftp.timeout` | a step passed its deadline | yes |
| `network_error` | `network.failed` | the connection could not be made or broke | yes, unless the host name is unknown |
| `provider_unavailable` | `provider.unavailable` | the server disconnected as busy | yes |
| `provider_error` | `provider.refused` | any other refusal | no |
| `cancelled`, `timeout` | `command.cancelled`, `command.timed-out` | the run's signal stopped it | no |

An error that was tried again carries `details.attempts`. No message quotes a path, a file name, the server's own
wording or a secret: a recording's file name often holds a caller's phone number.

## The run's events

Each attempt is a pair of `request` and `response` events with `transport: "sftp"`, `level: "wire"` and the attempt
number: `sftp.connect`, `sftp.list` (`counts.entries`), `sftp.stat`, `sftp.read` (`bytes`) and `sftp.host-key`. The
response carries `ids.host`, and an error its code. No event carries a path, a file name or content.
