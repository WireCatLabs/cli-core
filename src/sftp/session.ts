import type { Duplex } from "node:stream"
import {
  backoffMs,
  CliError,
  isCliError,
  type RetryConfig,
  realSleep,
  type SleepLike,
  type SleepReason,
} from "@wirecat/cli-base"
import { type ProviderAnswer, providerEvent, providerRequest } from "../cli/command-runs.js"
import type { RequestEvent } from "../runs/events.js"
import { type HostKey, openWire, probeHostKey, type SftpEntry, type Wire, type WireOptions } from "./ssh2.js"

export type SftpAuth = { password: string } | { privateKey: string | Uint8Array; passphrase?: string }

export interface SftpTarget {
  host: string
  /** 22 when not given. */
  port?: number
  /** Seams for a test or a tunnel: a stream already connected to the server, one per connection attempt. */
  socket?: () => Duplex | Promise<Duplex>
  /** The run's signal: aborting it stops every operation and closes the connection. */
  signal?: AbortSignal
  /** The run's events (WC-LIFE-17); the current command's run when not given. */
  events?: (event: RequestEvent) => void
  /** How long a connection may take up to an open SFTP channel. */
  connectTimeoutMs?: number
  retry?: RetryConfig
  sleep?: SleepLike
  random?: () => number
}

export interface SftpOptions extends SftpTarget {
  username: string
  auth: SftpAuth
  /** The host key fingerprint the owner confirmed, `SHA256:…` as `sftpHostKey` or `ssh-keygen -lf` print it. */
  hostKey: string
  /** How long one list or stat may take, and how long a read may go without receiving a byte. */
  operationTimeoutMs?: number
}

export interface SftpReadOptions {
  /** A larger file is refused before its first byte is read, and a file that grows past it while read is too. */
  maxBytes: number
}

export interface SftpClient {
  /** The entries of a folder, without `.` and `..`. */
  list(path: string): Promise<SftpEntry[]>
  stat(path: string): Promise<SftpEntry>
  readFile(path: string, options: SftpReadOptions): Promise<Uint8Array>
  close(): Promise<void>
}

export type { HostKey, SftpEntry, SftpKind } from "./ssh2.js"

export const SFTP_CONNECT_TIMEOUT_MS = 20_000
export const SFTP_OPERATION_TIMEOUT_MS = 30_000
/** Every operation only reads, so a transient failure is tried again: three attempts in all. */
export const SFTP_RETRY: RetryConfig = { retries: 2, baseDelayMs: 500, maxDelayMs: 5_000, maxRetryAfterMs: 0 }

const normalized = (fingerprint: string): string =>
  fingerprint
    .trim()
    .replace(/^SHA256:/i, "")
    .replace(/=+$/, "")

const stoppedBy = (signal: AbortSignal | undefined): CliError | undefined => {
  if (!signal?.aborted) return undefined
  if (isCliError(signal.reason)) return signal.reason
  const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  return new CliError(timeout ? "timeout" : "cancelled", "the SFTP operation was stopped before it finished", {
    reason: timeout ? "command.timed-out" : "command.cancelled",
  })
}

const timedOut = (what: string, ms: number) =>
  new CliError("timeout", `the SFTP server did not answer the ${what} within ${Math.ceil(ms / 1000)} s`, {
    reason: "sftp.timeout",
    retryable: true,
  })

/**
 * Runs `work` until it settles or `ms` pass without a call of `touch`. The wait goes through `sleep` with reason
 * `timeout`, so a test decides when a deadline passes.
 */
const deadline = async <T>(
  ms: number,
  sleep: SleepLike,
  expire: () => void,
  work: (touch: () => void) => Promise<T>,
): Promise<T> => {
  let timer = new AbortController()
  let expired = false
  const arm = () => {
    timer.abort()
    timer = new AbortController()
    sleep(ms, timer.signal, "timeout" satisfies SleepReason).then(
      () => {
        expired = true
        expire()
      },
      () => {},
    )
  }
  arm()
  try {
    return await work(arm)
  } catch (error) {
    if (expired) throw new Expired()
    throw error
  } finally {
    timer.abort()
  }
}

class Expired extends Error {}

interface Attempted<T> {
  operation: string
  run: (attempt: number) => Promise<T>
  answer?: (value: T) => ProviderAnswer
}

const retrying = async <T>(target: Required<Pick<SftpTarget, "sleep" | "random">> & SftpTarget, job: Attempted<T>) => {
  const retry = target.retry ?? SFTP_RETRY
  const events = target.events ?? providerEvent
  let waitMs: number | undefined
  for (let attempt = 1; ; attempt++) {
    const stop = stoppedBy(target.signal)
    if (stop) throw stop
    const answered = providerRequest(job.operation, events, {
      transport: "sftp",
      attempt,
      ...(waitMs === undefined ? {} : { waitMs }),
    })
    try {
      const value = await job.run(attempt)
      answered({ ids: { host: target.host }, ...job.answer?.(value) })
      return value
    } catch (caught) {
      const error = stoppedBy(target.signal) ?? caught
      answered({ ids: { host: target.host }, error, ...(isCliError(error) ? { errorCode: error.code } : {}) })
      const again = isCliError(error) && error.details.retryable === true && !target.signal?.aborted
      if (!again || attempt > retry.retries) {
        if (isCliError(error) && error.details.retryable === true)
          throw new CliError(error.code, error.message, { ...error.details, attempts: attempt })
        throw error
      }
      waitMs = backoffMs(attempt, retry, target.random)
      try {
        await target.sleep(waitMs, target.signal, "retry")
      } catch {
        throw stoppedBy(target.signal) ?? error
      }
    }
  }
}

const wireOptions = (target: SftpTarget, credentials: Partial<WireOptions> = {}): WireOptions => ({
  host: target.host,
  port: target.port ?? 22,
  username: credentials.username ?? "wirecat",
  password: credentials.password,
  privateKey: credentials.privateKey,
  passphrase: credentials.passphrase,
  socket: target.socket,
})

/** Opens the connection once, under the connect deadline and the run's signal. */
const connectOnce = async <T>(
  target: SftpTarget & { sleep: SleepLike },
  open: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const ms = target.connectTimeoutMs ?? SFTP_CONNECT_TIMEOUT_MS
  const attempt = new AbortController()
  const signal = target.signal ? AbortSignal.any([target.signal, attempt.signal]) : attempt.signal
  try {
    return await deadline(
      ms,
      target.sleep,
      () => attempt.abort(),
      () => open(signal),
    )
  } catch (error) {
    if (error instanceof Expired) throw timedOut("connection", ms)
    throw error
  }
}

const seams = <T extends SftpTarget>(target: T) => ({
  ...target,
  sleep: target.sleep ?? realSleep,
  random: target.random ?? Math.random,
})

/**
 * The server's host key, for a sign-in to show the owner before the fingerprint is pinned: the connection stops at
 * the key exchange and sends no credential.
 */
export const sftpHostKey = async (target: SftpTarget): Promise<HostKey> => {
  const options = seams(target)
  return retrying(options, {
    operation: "sftp.host-key",
    run: () => connectOnce(options, async (signal) => probeHostKey(wireOptions(options), signal)),
  })
}

const closedError = () => new CliError("validation_error", "the SFTP connection is closed", { reason: "sftp.closed" })

const refuseOptions = (options: SftpOptions): void => {
  if (!options.hostKey?.trim())
    throw new CliError(
      "configuration_error",
      "no host key is pinned for this SFTP server: show the owner its fingerprint (sftpHostKey) and pin the one confirmed",
      { reason: "sftp.host-key-missing" },
    )
  const auth = options.auth as Partial<{ password: string; privateKey: string | Uint8Array }>
  if (!auth?.password && !auth?.privateKey)
    throw new CliError("configuration_error", "an SFTP connection needs a password or a private key", {
      reason: "sftp.auth-missing",
    })
}

/**
 * A read-only SFTP connection: list, stat and read, nothing that writes. The host key must match the pinned
 * fingerprint before a credential is sent. Each operation is a request in the run's events (host and operation,
 * never a path or file content) and is tried again on a transient failure over a fresh connection.
 */
export const openSftp = async (input: SftpOptions): Promise<SftpClient> => {
  refuseOptions(input)
  const options = seams(input)
  const pinned = normalized(options.hostKey)
  const operationMs = options.operationTimeoutMs ?? SFTP_OPERATION_TIMEOUT_MS
  const credentials: Partial<WireOptions> = {
    username: options.username,
    ...("password" in options.auth
      ? { password: options.auth.password }
      : { privateKey: options.auth.privateKey, passphrase: options.auth.passphrase }),
  }
  let wire: Wire | undefined
  let closed = false

  const drop = () => {
    wire?.close()
    wire = undefined
  }
  const abort = () => drop()
  options.signal?.addEventListener("abort", abort, { once: true })

  const connected = async (): Promise<Wire> => {
    if (closed) throw closedError()
    if (wire) return wire
    const opened = await connectOnce(options, async (signal) =>
      openWire(wireOptions(options, credentials), (key) => normalized(key.fingerprint) === pinned, signal),
    )
    if (options.signal?.aborted || closed) {
      opened.close()
      throw stoppedBy(options.signal) ?? closedError()
    }
    wire = opened
    return opened
  }

  const operation = <T>(
    name: string,
    work: (wire: Wire, touch: () => void) => Promise<T>,
    answer?: Attempted<T>["answer"],
  ) =>
    retrying(options, {
      operation: name,
      run: async () => {
        const current = await connected()
        try {
          return await deadline(
            operationMs,
            options.sleep,
            () => current.close(),
            (touch) => work(current, touch),
          )
        } catch (error) {
          if (error instanceof Expired) {
            drop()
            throw timedOut("request", operationMs)
          }
          if (isCliError(error) && error.details.retryable === true) drop()
          throw error
        }
      },
      ...(answer ? { answer } : {}),
    })

  await retrying(options, { operation: "sftp.connect", run: () => connected() })

  return {
    list: (path) =>
      operation(
        "sftp.list",
        (current) => current.list(path),
        (entries) => ({ counts: { entries: entries.length } }),
      ),
    stat: (path) => operation("sftp.stat", (current) => current.stat(path)),
    readFile: (path, { maxBytes }) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        return Promise.reject(
          new CliError("validation_error", "maxBytes must be a whole number of bytes, 0 or more", {
            reason: "input.invalid",
          }),
        )
      return operation(
        "sftp.read",
        (current, touch) => current.read(path, maxBytes, touch),
        (bytes) => ({ bytes: bytes.length }),
      )
    },
    close: async () => {
      closed = true
      options.signal?.removeEventListener("abort", abort)
      drop()
    },
  }
}
