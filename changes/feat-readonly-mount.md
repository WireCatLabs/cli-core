### Added

- **`@wirecat/cli-core/mount`: show a service's folder as a read-only folder on this computer.** `serveMount` serves a
  `MountSource` (`stat`, `list`, `read` of a byte range; it has no write) over WebDAV on 127.0.0.1, which the system's
  own client mounts: `gio mount` on Linux, Finder on macOS, `net use` on Windows. Every request must carry a random
  per-run secret in its path and this machine's `Host`, so another site's page cannot reach it. Only OPTIONS,
  PROPFIND, GET and HEAD are answered; every write method is refused (405, MKCOL 403), and a file is served sandboxed
  so an HTML file on the mount cannot script it. Listings are kept 10 seconds, so a file manager's
  probes do not spend the service's rate limit ([mount](../docs/mount.md)).

### Fixed

- **A local server's answer ends when its body fails part-way.** `listen` left the connection open, and the client
  waited for bytes that never came.
