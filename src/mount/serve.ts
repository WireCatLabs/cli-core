import { randomBytes } from "node:crypto"
import { listen } from "../http/listen.js"
import type { MountSource } from "./source.js"
import { webdavHandler } from "./webdav.js"

const HOST = "127.0.0.1"
/** A PROPFIND body is a few hundred bytes; a larger body, such as a file a client tries to upload, is refused unread. */
const MOST_BODY = 64 * 1024

export interface MountOptions {
  /** 0 picks a free port. */
  port?: number
  /** A new random one each run when left out. */
  secret?: string
  cacheMs?: number
  now?: () => number
  onError?: (error: unknown) => void
}

export interface Mounted {
  /** Holds the per-run secret and nothing else: no token, no account. */
  url: string
  /** The command or the steps that mount `url` on each system. */
  how: { linux: string; macos: string; windows: string }
  close(): Promise<void>
}

/** The ways to mount a URL the system's own WebDAV client understands, so no driver is installed. */
export const mountSteps = (url: string): Mounted["how"] => ({
  linux: `gio mount ${url.replace(/^http:/u, "dav:")}`,
  macos: `Finder > Go > Connect to Server (Cmd+K), then ${url}`,
  windows: `net use * ${url}`,
})

/**
 * Serves `source` read-only over WebDAV on 127.0.0.1, behind a random secret in the path. Only this machine can
 * reach it, and only a client that was given the URL.
 */
export const serveMount = async (source: MountSource, options: MountOptions = {}): Promise<Mounted> => {
  const secret = options.secret ?? randomBytes(24).toString("base64url")
  let port = options.port ?? 0
  const handle = webdavHandler(source, {
    secret,
    hosts: () => [`${HOST}:${port}`, `localhost:${port}`],
    ...(options.cacheMs === undefined ? {} : { cacheMs: options.cacheMs }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  })
  const listening = await listen(handle, { host: HOST, port, maxBody: MOST_BODY })
  port = Number(listening.url.port)
  const url = `http://${HOST}:${port}/${secret}/`
  return { url, how: mountSteps(url), close: listening.close }
}
