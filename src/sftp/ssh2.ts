import { createHash } from "node:crypto"
import { basename } from "node:path"
import type { Duplex } from "node:stream"
import { CliError, isCliError } from "@wirecat/cli-base"
import type { Attributes, Client, ConnectConfig, FileEntry, SFTPWrapper, Stats } from "ssh2"

/** What a server's host key is, as `ssh-keygen -lf` prints it: `SHA256:` and unpadded base64. */
export interface HostKey {
  algorithm: string
  fingerprint: string
}

export type SftpKind = "file" | "directory" | "symlink" | "other"

export interface SftpEntry {
  name: string
  kind: SftpKind
  size: number
  /** ISO 8601, from the server's whole-second modification time. */
  modifiedAt: string
}

export interface WireOptions {
  host: string
  port: number
  username: string
  password?: string | undefined
  privateKey?: string | Uint8Array | undefined
  passphrase?: string | undefined
  /** Opens a stream already connected to the server, instead of a TCP connection to `host`. */
  socket?: (() => Duplex | Promise<Duplex>) | undefined
}

export interface Wire {
  list(path: string): Promise<SftpEntry[]>
  stat(path: string): Promise<SftpEntry>
  read(path: string, maxBytes: number, progress: () => void): Promise<Uint8Array>
  close(): void
}

type Ssh2 = typeof import("ssh2")

let library: Promise<Ssh2> | undefined

/** ssh2 is an optional peer: a CLI that never speaks SFTP neither installs nor loads it. */
const ssh2 = (): Promise<Ssh2> => {
  library ??= import("ssh2").then(
    (module) => ((module as { default?: Ssh2 }).default ?? module) as Ssh2,
    () => {
      library = undefined
      throw new CliError("configuration_error", "SFTP needs the ssh2 package: add ssh2 to this CLI's dependencies", {
        reason: "sftp.library-missing",
      })
    },
  )
  return library
}

export const hostKeyOf = (blob: Buffer): HostKey => {
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0
  const algorithm = /^[\w@.-]{1,64}$/.test(blob.toString("latin1", 4, 4 + length))
    ? blob.toString("latin1", 4, 4 + length)
    : "unknown"
  const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`
  return { algorithm, fingerprint }
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
])

/** SFTP status codes (draft-ietf-secsh-filexfer-02, section 7). */
const NO_SUCH_FILE = 2
const PERMISSION_DENIED = 3
const NO_CONNECTION = 6
const CONNECTION_LOST = 7

/** SSH disconnect reasons (RFC 4253, section 11.1) a busy or restarting server sends: service not available, connection
 * lost, too many connections. */
const DISCONNECTS_TO_RETRY = new Set([7, 10, 12])

const lost = () =>
  new CliError("network_error", "the connection to the SFTP server broke", {
    reason: "network.failed",
    retryable: true,
  })

/**
 * The vendor's error as a CliError with fixed wording: an SFTP server's message and the path asked can name a caller's
 * phone number, and a key error can quote the key (WC-SECR-6).
 */
const failureOf = (error: unknown, from: "ssh" | "sftp" = "sftp"): CliError => {
  if (isCliError(error)) return error
  const { code, level, message } = (error ?? {}) as { code?: unknown; level?: unknown; message?: unknown }
  if (level === "client-authentication")
    return new CliError("authentication_error", "the SFTP server refused the user name and password or key", {
      reason: "auth.failed",
    })
  if (from === "ssh" && typeof code === "number")
    return new CliError(
      DISCONNECTS_TO_RETRY.has(code) ? "provider_unavailable" : "provider_error",
      `the SFTP server ended the connection (SSH disconnect reason ${code})`,
      {
        reason: DISCONNECTS_TO_RETRY.has(code) ? "provider.unavailable" : "provider.refused",
        ...(DISCONNECTS_TO_RETRY.has(code) ? { retryable: true } : {}),
      },
    )
  if (code === NO_SUCH_FILE)
    return new CliError("not_found", "no such file or folder on the SFTP server", { reason: "file.not-found" })
  if (code === PERMISSION_DENIED)
    return new CliError("permission_error", "the SFTP server denied access to the path", { reason: "file.denied" })
  if (code === NO_CONNECTION || code === CONNECTION_LOST || message === "No response from server") return lost()
  if (level === "client-dns" || code === "ENOTFOUND")
    return new CliError("network_error", "the SFTP server's host name was not found", { reason: "network.failed" })
  if (
    (typeof code === "string" && TRANSIENT_CODES.has(code)) ||
    level === "client-socket" ||
    level === "client-timeout" ||
    level === "protocol"
  )
    return lost()
  if (typeof code === "number")
    return new CliError("provider_error", `the SFTP server refused the request (status ${code})`, {
      reason: "provider.refused",
    })
  return new CliError("provider_unavailable", "the SFTP server failed the request", {
    reason: "provider.unavailable",
    retryable: true,
  })
}

const KIND_BITS = 0o170000
const kindOf = (mode: number): SftpKind => {
  const bits = mode & KIND_BITS
  if (bits === 0o100000) return "file"
  if (bits === 0o040000) return "directory"
  if (bits === 0o120000) return "symlink"
  return "other"
}

const entryOf = (name: string, attrs: Attributes): SftpEntry => ({
  name,
  kind: kindOf(attrs.mode),
  size: Number(attrs.size),
  modifiedAt: new Date(attrs.mtime * 1000).toISOString(),
})

const tooLarge = (maxBytes: number) =>
  new CliError("validation_error", `the file is larger than the read's limit of ${maxBytes} bytes`, {
    reason: "sftp.too-large",
    max_bytes: maxBytes,
  })

const CHUNK = 64 * 1024
const IN_FLIGHT = 16

const readAll = async (sftp: SFTPWrapper, path: string, maxBytes: number, progress: () => void) => {
  const call = <T>(work: (done: (error: unknown, value?: T) => void) => void) =>
    new Promise<T>((resolve, reject) =>
      work((error, value) => (error ? reject(failureOf(error)) : resolve(value as T))),
    )
  const handle = await call<Buffer>((done) => sftp.open(path, "r", (error, value) => done(error, value)))
  const readAt = (position: number, length: number) =>
    call<Buffer>((done) => {
      const into = Buffer.alloc(length)
      sftp.read(handle, into, 0, length, position, (error, bytes) => done(error, into.subarray(0, bytes)))
    })
  // A server may answer a read with fewer bytes than asked; only an empty answer is the end of the file.
  const fill = async (position: number, length: number) => {
    const parts: Buffer[] = []
    let got = 0
    while (got < length) {
      const part = await readAt(position + got, length - got)
      if (part.length === 0) break
      parts.push(part)
      got += part.length
      progress()
    }
    return Buffer.concat(parts, got)
  }
  try {
    const stats = await call<Stats>((done) => sftp.fstat(handle, (error, value) => done(error, value)))
    if (kindOf(stats.mode) !== "file")
      throw new CliError("validation_error", "the path names a folder or another thing that is not a file", {
        reason: "file.not-a-file",
      })
    if (stats.size > maxBytes) throw tooLarge(maxBytes)
    const size = Number(stats.size)
    const pieces: Buffer[] = []
    let next = 0
    const worker = async () => {
      for (let index = next++; index * CHUNK < size; index = next++)
        pieces[index] = await fill(index * CHUNK, Math.min(CHUNK, size - index * CHUNK))
    }
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, Math.ceil(size / CHUNK)) }, worker))
    const short = pieces.findIndex((piece, index) => piece.length < Math.min(CHUNK, size - index * CHUNK))
    const parts = short === -1 ? pieces : pieces.slice(0, short + 1)
    let total = parts.reduce((sum, part) => sum + part.length, 0)
    // The size came from a stat; a file still being written can be longer by now, so read on to its end.
    for (let tail = short === -1 ? await fill(total, CHUNK) : Buffer.alloc(0); tail.length > 0; ) {
      parts.push(tail)
      total += tail.length
      if (total > maxBytes) throw tooLarge(maxBytes)
      tail = await fill(total, CHUNK)
    }
    return new Uint8Array(Buffer.concat(parts, total))
  } finally {
    sftp.close(handle, () => {})
  }
}

const validKey = (library: Ssh2, options: WireOptions): void => {
  if (options.privateKey === undefined) return
  const key = typeof options.privateKey === "string" ? options.privateKey : Buffer.from(options.privateKey)
  const parsed = library.utils.parseKey(key, options.passphrase)
  if (parsed instanceof Error)
    throw new CliError("configuration_error", "the SFTP private key cannot be read: check the key and its passphrase", {
      reason: "sftp.key-invalid",
    })
}

const configOf = async (options: WireOptions, verify: (key: Buffer) => boolean): Promise<ConnectConfig> => ({
  host: options.host,
  port: options.port,
  username: options.username,
  ...(options.password === undefined ? {} : { password: options.password }),
  ...(options.privateKey === undefined
    ? {}
    : {
        privateKey: typeof options.privateKey === "string" ? options.privateKey : Buffer.from(options.privateKey),
      }),
  ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
  ...(options.socket ? { sock: await options.socket() } : {}),
  // The caller's own deadline bounds the handshake; ssh2's timer would be a second, unseen clock.
  readyTimeout: 0,
  keepaliveInterval: 10_000,
  keepaliveCountMax: 3,
  tryKeyboard: false,
  hostVerifier: verify,
})

/**
 * Connects, checks the host key with `accept` before any credential is sent, and opens the SFTP channel. `signal`
 * ends the attempt and destroys the connection.
 */
export const openWire = async (
  options: WireOptions,
  accept: (key: HostKey) => boolean,
  signal: AbortSignal,
): Promise<Wire> => {
  const library = await ssh2()
  validKey(library, options)
  signal.throwIfAborted()
  const client: Client = new library.Client()
  let refused: HostKey | undefined
  const verify = (blob: Buffer) => {
    const key = hostKeyOf(blob)
    if (accept(key)) return true
    refused = key
    return false
  }
  const config = await configOf(options, verify)
  signal.throwIfAborted()
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const stop = () => {
      client.destroy()
      reject(signal.reason)
    }
    signal.addEventListener("abort", stop, { once: true })
    const fail = (error: unknown) => {
      signal.removeEventListener("abort", stop)
      client.destroy()
      reject(
        refused
          ? new CliError(
              "authentication_error",
              `the SFTP server's host key (${refused.algorithm} ${refused.fingerprint}) is not the pinned one; ` +
                "check it with the server's owner before pinning it again",
              { reason: "sftp.host-key-mismatch" },
            )
          : failureOf(error, "ssh"),
      )
    }
    client.once("error", fail)
    client.once("close", () => fail(lost()))
    client.once("ready", () =>
      client.sftp((error, channel) => {
        if (error) return fail(error)
        signal.removeEventListener("abort", stop)
        client.removeListener("error", fail)
        client.on("error", () => {})
        resolve(channel)
      }),
    )
    client.connect(config)
  })
  return wireOf(client, sftp)
}

const wireOf = (client: Client, sftp: SFTPWrapper): Wire => {
  const pending = new Set<(error: CliError) => void>()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const reject of pending) reject(lost())
    pending.clear()
    client.destroy()
  }
  client.once("close", close)
  const guarded = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(lost())
    return new Promise<T>((resolve, reject) => {
      const settle = (error: CliError) => reject(error)
      pending.add(settle)
      work().then(
        (value) => {
          pending.delete(settle)
          resolve(value)
        },
        (error: unknown) => {
          pending.delete(settle)
          reject(failureOf(error))
        },
      )
    })
  }
  return {
    list: (path) =>
      guarded(
        () =>
          new Promise<SftpEntry[]>((resolve, reject) =>
            sftp.readdir(path, (error, list: FileEntry[]) =>
              error
                ? reject(error)
                : resolve(
                    list
                      .filter((one) => one.filename !== "." && one.filename !== "..")
                      .map((one) => entryOf(one.filename, one.attrs)),
                  ),
            ),
          ),
      ),
    stat: (path) =>
      guarded(
        () =>
          new Promise<SftpEntry>((resolve, reject) =>
            sftp.stat(path, (error, attrs) => (error ? reject(error) : resolve(entryOf(basename(path), attrs)))),
          ),
      ),
    read: (path, maxBytes, progress) => guarded(() => readAll(sftp, path, maxBytes, progress)),
    close,
  }
}

/** Connects only as far as the server's host key, and returns it; no credential is sent. */
export const probeHostKey = async (options: WireOptions, signal: AbortSignal): Promise<HostKey> => {
  const library = await ssh2()
  signal.throwIfAborted()
  const client: Client = new library.Client()
  let seen: HostKey | undefined
  const config = await configOf(options, (blob) => {
    seen = hostKeyOf(blob)
    return false
  })
  signal.throwIfAborted()
  return new Promise<HostKey>((resolve, reject) => {
    const stop = () => {
      client.destroy()
      reject(signal.reason)
    }
    signal.addEventListener("abort", stop, { once: true })
    const done = (error?: unknown) => {
      signal.removeEventListener("abort", stop)
      client.destroy()
      if (seen) resolve(seen)
      else reject(failureOf(error ?? lost(), "ssh"))
    }
    client.once("error", done)
    client.once("close", () => done())
    client.connect(config)
  })
}
