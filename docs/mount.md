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
- Only OPTIONS, PROPFIND, GET and HEAD are answered; PUT, DELETE, MOVE, COPY, MKCOL, PROPPATCH, LOCK and UNLOCK get
  405. A request body larger than 64 KB is refused unread.
- A path segment that decodes to `/`, `\`, NUL, `.` or `..` is refused, so `a%2F..%2F..` cannot climb out of the
  mounted folder.
- The server says `DAV: 1` and offers no locks.

## Performance

A listing and a stat are kept 10 seconds, and a stat is answered from its parent's listing, so the `.DS_Store`,
`desktop.ini` and thumbnail probes of a file manager are not requests to the service. `HEAD` and `PROPFIND` never
read a file; `GET` with a `Range` asks the source for that range only.
