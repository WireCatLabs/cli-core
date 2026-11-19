# Read-only mount

`@wirecat/cli-core/mount` shows a folder of a service (Yandex Disk, Google Drive, Notion) as a folder on the owner's
computer, read-only. It serves the folder over WebDAV on 127.0.0.1, and the system's own WebDAV client mounts it, so
nothing is installed: no FUSE, no driver.

A CLI supplies a `MountSource` with three reads:

```ts
interface MountSource {
  stat(path: string): Promise<MountEntry>
  list(path: string): Promise<MountEntry[]>
  read(path: string, entry: MountEntry, range?: ByteRange): Promise<MountRead>
}
```

Paths are `/` or `/a/b` under the mounted folder; a missing item throws `not_found`. `read` returns `ranged: false`
when the service sent the whole file instead of the range, and the mount then answers the whole file. The source
has no method that writes, so a mount cannot change the service whatever a client asks.

`serveMount(source, { port })` returns the URL and the way to mount it on each system (`how`). The command that runs
it declares `lifetime: "persistent"`, so it is never offered over MCP, and closes the server when it stops.

## What keeps it safe

- It listens on 127.0.0.1 only.
- The URL holds a random secret, new each run; a request without it gets 404. The URL holds nothing else: no token.
- The `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and an `Origin` must be the same; a page on another site
  that points its name at 127.0.0.1 (DNS rebinding) is refused. No answer carries a CORS header.
- Only OPTIONS, PROPFIND, GET and HEAD are answered; PUT, DELETE, MOVE, COPY, PROPPATCH, LOCK and UNLOCK get 405,
  and MKCOL 403, since a 405 to MKCOL means "it already exists" (RFC 4918). A request body larger than 64 KB is refused
  unread.
- A file is served with `Content-Security-Policy: sandbox` and `nosniff`: an HTML or SVG file opened from the mount
  in a browser cannot run on the mount's origin, read the secret from its own address and fetch the rest.
- A path segment that decodes to `/`, `\`, NUL, `.` or `..` is refused, so `a%2F..%2F..` cannot climb out of the
  mounted folder.
- The server says `DAV: 1` and offers no locks, and marks each item read-only in Microsoft's `Win32FileAttributes`.

## Clients

Checked with GNOME's gvfs (`gio mount dav://…`, 2026-11-19): listing, reading and partial reads work; `mkdir` is
refused, and `rm`, `mv` and `gio copy` fail. Through gvfs's FUSE folder, `touch` and `echo >` exit 0 although
nothing is written: gvfs drops the error of the upload it makes when the file closes. Finder and Windows' WebClient
are not checked yet.

## Performance

A listing and a stat are kept 10 seconds, and a stat is answered from its parent's listing, so the `.DS_Store`,
`desktop.ini` and thumbnail probes of a file manager are not requests to the service. `HEAD` and `PROPFIND` never
read a file; `GET` with a `Range` asks the source for that range only.
