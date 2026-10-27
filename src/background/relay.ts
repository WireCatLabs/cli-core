import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { CliError, type Streams } from "@wirecat/cli-base"
import * as v from "valibot"

/** Raised when a frame or its meaning changes; a client and a serve that differ refuse rather than guess. */
export const RELAY_PROTOCOL = 1

/** Where a serve advertises its relay, in its lock. */
export interface RelayAddress {
  path: string
  protocol: number
}

/** What a client asks serve to run: its own words, environment and working directory. */
export interface RelayRequest {
  argv: string[]
  env: Record<string, string>
  cwd: string
  /** Whether the client's stdout is a terminal — it decides human or machine output. */
  tty: boolean
  /** Whether the client's stdin is a terminal; its bytes are then not sent. */
  stdinTty: boolean
}

/** What serve hands the command it runs for a client. */
export interface RelayIo {
  streams: Streams
  stdin: PassThrough & { isTTY?: boolean }
  /** Raw bytes for the client's stdout — an MCP session's wire. */
  stdout: Writable
  signal: AbortSignal
}

const requestSchema = v.strictObject({
  argv: v.array(v.string()),
  env: v.record(v.string(), v.string()),
  cwd: v.pipe(
    v.string(),
    v.check((path) => isAbsolute(path)),
  ),
  tty: v.boolean(),
  stdinTty: v.boolean(),
})

/** The longest line either side accepts. A client's lines are stdin chunks; serve's can be a whole answer. */
const MAX_CLIENT_LINE = 1024 * 1024
const MAX_SERVE_LINE = 64 * 1024 * 1024
/** Linux allows 108 bytes in a socket path, macOS 104. */
const MAX_SOCKET_PATH = 100

/**
 * The relay socket beside the serve lock. A state directory too deep for a socket path moves it to a private
 * directory under the system's temporary one, or under /tmp when that is too deep too, named by a hash of the path
 * it replaces.
 */
export const relayPath = (lockPath: string): string => {
  const beside = lockPath.replace(/\.lock$/, ".sock")
  if (beside.length <= MAX_SOCKET_PATH) return beside
  const hash = createHash("sha256").update(beside).digest("hex").slice(0, 16)
  const name = join(`wirecat-relay-${process.getuid?.() ?? "user"}`, `${hash}.sock`)
  const temporary = join(tmpdir(), name)
  // macOS gives each user a deep TMPDIR under /var/folders, and a custom one can be deeper still.
  if (temporary.length <= MAX_SOCKET_PATH || process.platform === "win32") return temporary
  return join("/tmp", name)
}

/** Owner-only, or nothing: a directory someone else made, or others can enter, is not ours to listen in. */
const privateDirectory = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  const mine = process.getuid === undefined || stat.uid === process.getuid()
  if (!stat.isDirectory() || !mine || (stat.mode & 0o077) !== 0) {
    throw new CliError("permission_error", `${dir} is not a private directory, so serve does not listen there`)
  }
}

const lines = (socket: Socket, max: number, onLine: (line: string) => void, onTooLong: () => void) => {
  let buffered = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      if (line) onLine(line)
    }
    if (buffered.length > max) onTooLong()
  })
}

const frame = (socket: Socket, value: object) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
}

/**
 * Listens for clients on `path` (mode 0600 in a 0700 directory: the same OS user only) and runs each one's command
 * through `run`. A client that goes away aborts its command; a command that fails is that client's answer and
 * never stops the listener.
 */
export const listenRelay = async (
  path: string,
  run: (request: RelayRequest, io: RelayIo) => Promise<number>,
): Promise<{ close: () => Promise<void> }> => {
  privateDirectory(dirname(path))
  // The caller holds the serve lock, so a socket left here belongs to a serve that is gone.
  rmSync(path, { force: true })
  const open = new Set<Socket>()
  const running = new Set<Promise<void>>()
  const server = createServer((socket) => {
    open.add(socket)
    const stop = new AbortController()
    const stdin = new PassThrough() as RelayIo["stdin"]
    let started = false
    socket.on("error", () => {})
    socket.on("close", () => {
      open.delete(socket)
      stop.abort(new CliError("cancelled", "the client went away", { retryable: false }))
      if (!stdin.writableEnded) stdin.end()
    })
    lines(
      socket,
      MAX_CLIENT_LINE,
      (line) => {
        let message: { run?: unknown; v?: unknown; stdin?: unknown; stdinEnd?: unknown }
        try {
          message = JSON.parse(line)
        } catch {
          socket.destroy()
          return
        }
        if (!started) {
          started = true
          if (message.v !== RELAY_PROTOCOL) {
            frame(socket, { diagnostic: `serve speaks relay protocol ${RELAY_PROTOCOL}; restart it`, exit: 1 })
            socket.end()
            return
          }
          const parsed = v.safeParse(requestSchema, message.run)
          if (!parsed.success) {
            socket.destroy()
            return
          }
          stdin.isTTY = parsed.output.stdinTty
          if (parsed.output.stdinTty) stdin.end()
          const job = serve(socket, parsed.output, stdin, stop.signal, run)
          running.add(job)
          void job.then(
            () => running.delete(job),
            () => running.delete(job),
          )
          return
        }
        if (typeof message.stdin === "string" && !stdin.writableEnded) stdin.write(Buffer.from(message.stdin, "base64"))
        if (message.stdinEnd === true && !stdin.writableEnded) stdin.end()
      },
      () => socket.destroy(),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      resolve()
    })
  })
  chmodSync(path, 0o600)
  return {
    close: async () => {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.allSettled(running)
      rmSync(path, { force: true })
    },
  }
}

const serve = async (
  socket: Socket,
  request: RelayRequest,
  stdin: RelayIo["stdin"],
  signal: AbortSignal,
  run: (request: RelayRequest, io: RelayIo) => Promise<number>,
) => {
  const streams: Streams = {
    data: (text) => frame(socket, { data: text }),
    diagnostic: (text) => frame(socket, { diagnostic: text }),
    progress: (text) => frame(socket, { progress: text }),
  }
  const stdout = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      frame(socket, { raw: Buffer.from(chunk).toString("base64") })
      done()
    },
  })
  let code = 1
  try {
    code = await run(request, { streams, stdin, stdout, signal })
  } finally {
    frame(socket, { exit: code })
    socket.end()
  }
}

export interface RelayClientOptions {
  streams: Streams
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream
  signal: AbortSignal
  /** Give up after this long with no exit from serve; none for a command that listens until stopped. */
  deadlineMs?: number
  /** A command that listens until stopped — `watch`, `mcp` — ends normally when the signal stops it. */
  listens?: boolean
  /** Whether the command writes: a serve that stops mid-way then leaves its outcome unknown. */
  writes: boolean
  /** What to name in an error: `wa personal serve (PID 4242)`. */
  holder: string
}

/**
 * Runs `request` in the serve listening on `path` and returns its exit code, having printed what it printed. A
 * serve that does not answer, or stops before the exit, fails here — never by opening a connection of our own.
 */
export const relayCommand = (path: string, request: RelayRequest, options: RelayClientOptions): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const { streams, stdin, stdout, signal, deadlineMs, writes, holder, listens = false } = options
    const socket = createConnection(path)
    let connected = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const forward = (chunk: Buffer | string) => frame(socket, { stdin: Buffer.from(chunk).toString("base64") })
    const ended = () => frame(socket, { stdinEnd: true })
    // `| head` stopped reading: the run in serve goes with the socket, and ending is not a failure.
    const brokenPipe = (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") finish({ code: 0 })
    }
    const finish = (outcome: { code: number } | { error: unknown }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      stdout.off("error", brokenPipe)
      signal.removeEventListener("abort", aborted)
      stdin.off("data", forward).off("end", ended)
      stdin.pause()
      socket.destroy()
      if ("code" in outcome) resolve(outcome.code)
      else reject(outcome.error)
    }
    const stopped = () =>
      writes
        ? new CliError(
            "outcome_unknown",
            `${holder} stopped before the command finished; it may have run — check before repeating it`,
            { retryable: false },
          )
        : new CliError("provider_unavailable", `${holder} stopped before the command finished`, { retryable: true })
    const aborted = () => finish(listens ? { code: 0 } : { error: signal.reason })
    if (signal.aborted) return aborted()
    signal.addEventListener("abort", aborted, { once: true })
    stdout.on("error", brokenPipe)
    if (deadlineMs !== undefined) timer = setTimeout(() => finish({ error: stopped() }), deadlineMs)

    socket.on("connect", () => {
      connected = true
      frame(socket, { v: RELAY_PROTOCOL, run: request })
      if (request.stdinTty) ended()
      else {
        stdin.on("data", forward).once("end", ended)
        stdin.resume()
      }
    })
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (connected) return finish({ error: stopped() })
      finish({
        error: new CliError(
          "provider_unavailable",
          `${holder} holds the connection but does not answer its relay (${error.code ?? error.message}) — restart it`,
          { retryable: false, sent: false },
        ),
      })
    })
    socket.on("close", () => finish({ error: stopped() }))
    lines(
      socket,
      MAX_SERVE_LINE,
      (line) => {
        let message: { data?: unknown; diagnostic?: unknown; progress?: unknown; raw?: unknown; exit?: unknown }
        try {
          message = JSON.parse(line)
        } catch {
          return finish({ error: stopped() })
        }
        if (typeof message.data === "string") streams.data(message.data)
        if (typeof message.diagnostic === "string") streams.diagnostic(message.diagnostic)
        if (typeof message.progress === "string") streams.progress?.(message.progress)
        if (typeof message.raw === "string") stdout.write(Buffer.from(message.raw, "base64"))
        if (typeof message.exit === "number") finish({ code: message.exit })
      },
      () => finish({ error: stopped() }),
    )
  })
