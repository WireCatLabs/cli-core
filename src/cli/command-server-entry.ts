import { PassThrough } from "node:stream"
import { CliError, catchCrashes } from "@wirecat/cli-base"
import { asOwnProcess } from "../runs/scope.js"
import { ensureSqlite } from "../sqlite-runtime.js"
import { COMMAND_SERVER_CONCURRENT, type CommandAnswer, enterCommandServer, serveCommands } from "./command-server.js"
import {
  type CommandServerRequest,
  commandServerRequest,
  exitCodeSet,
  inCommandServerRequest,
} from "./command-server-request.js"
import type { CliEntry, EntryContext, EntryIo, firstRunAt } from "./entry.js"

/** What `startCli` already has, handed in so the two modules do not import each other. */
export interface EntryParts {
  firstRunAt: typeof firstRunAt
  commanderExit: (error: unknown) => number | undefined
}

type Sink = (chunk: Buffer) => void

/**
 * Every write to the process's stream goes to `sink()`. The stream's `write` is replaced, not the stream: the global
 * console keeps the stream it first wrote to, and `complete` prints through it.
 */
const route = (stream: NodeJS.WriteStream, sink: () => Sink): (() => void) => {
  const original = stream.write
  stream.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    sink()(
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : Buffer.from(chunk),
    )
    const done = typeof encoding === "function" ? encoding : callback
    if (done) process.nextTick(done)
    return true
  }) as NodeJS.WriteStream["write"]
  return () => {
    stream.write = original
  }
}

// As a spawned run that Desktop gave no input: anything that reads stdin sees it end at once.
const closedStdin = () => {
  const stdin = new PassThrough()
  stdin.end()
  return stdin
}

// Each request reads its own stream: commands keep per-stream state, such as the input policy, under it.
const useStdin = (outside: NodeJS.ReadableStream) =>
  Object.defineProperty(process, "stdin", {
    get: () => commandServerRequest()?.stdin ?? outside,
    configurable: true,
    enumerable: true,
  })

// Each run adds its own signal and stdout `error` listeners, so a full server passes Node's warning at 10.
const roomFor = (runs: number): (() => void) => {
  const emitters = [process, process.stdout, process.stderr]
  const before = emitters.map((emitter) => emitter.getMaxListeners())
  for (const emitter of emitters) emitter.setMaxListeners(emitter.getMaxListeners() + 2 * runs)
  return () => {
    for (const [at, emitter] of emitters.entries()) emitter.setMaxListeners(before[at] as number)
  }
}

/**
 * `startCli` for `<cli> commands --serve`: each request runs the CLI's own `run` as a spawned process would, and its
 * output, which the process's streams would have carried, comes back in the answer. Between requests nothing reaches
 * stdout but the protocol; a late write goes to stderr.
 */
export const serveEntry = async (
  entry: CliEntry,
  io: EntryIo,
  { firstRunAt, commanderExit }: EntryParts,
): Promise<void> => {
  const release = catchCrashes({
    cli: entry.app.command,
    interactive: false,
    ...(entry.reasons ? { reasons: entry.reasons } : {}),
    target: io.signals,
  })
  const stopper = new AbortController()
  const stop = () => stopper.abort(new CliError("cancelled", "the command server was stopped", { retryable: false }))
  const protocol = io.stdout.write.bind(io.stdout)
  const ownStderr = io.stderr.write.bind(io.stderr)
  const toStderr: Sink = (chunk) => {
    ownStderr(chunk)
  }
  const sink = (pick: (request: CommandServerRequest) => Buffer[]) => () => {
    const request = commandServerRequest()
    return request ? (chunk: Buffer) => pick(request).push(chunk) : toStderr
  }
  const unrouteOut = route(
    process.stdout,
    sink((request) => request.stdout),
  )
  const unrouteErr = route(
    process.stderr,
    sink((request) => request.stderr),
  )
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")
  const requests = io.stdin
  useStdin(closedStdin())
  const unroom = roomFor(COMMAND_SERVER_CONCURRENT)
  io.signals.on("SIGINT", stop).on("SIGTERM", stop)
  io.stdout.on("error", stop)

  const run = async (argv: string[], alone: () => Promise<void>): Promise<CommandAnswer> => {
    const request: CommandServerRequest = { stdout: [], stderr: [], stdin: closedStdin(), alone }
    const requestIo: EntryIo = { ...io, argv: [...io.argv.slice(0, 2), ...argv], stdin: request.stdin }
    const context: EntryContext = {
      args: argv,
      env: io.env,
      tty: false,
      signal: stopper.signal,
      atStart: async (command) => {
        await enterCommandServer(command, entry.app.command)
        await firstRunAt(entry, requestIo, () => true)(command)
      },
      ask: async () => false,
      openBrowser: async () => undefined,
      outputClosed: () => false,
      setExitCode: (code) => {
        request.exitCode = code
      },
    }
    // Lines written outside a run name the process's run; each request is a process of its own.
    const code = await inCommandServerRequest(request, () =>
      asOwnProcess(async () => {
        try {
          const returned = await entry.run(context)
          return typeof returned === "number" ? returned : (exitCodeSet() ?? 0)
        } catch (error) {
          return commanderExit(error) ?? entry.fail(error, context)
        }
      }),
    )
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8")
    return { code, stdout: text(request.stdout), stderr: text(request.stderr) }
  }

  try {
    if (entry.sqlite) await ensureSqlite()
    await serveCommands({
      input: requests,
      write: (line) => new Promise((resolve) => (protocol(line) ? resolve() : io.stdout.once("drain", resolve))),
      run,
      cli: entry.app.command,
      concurrent: COMMAND_SERVER_CONCURRENT,
      version: entry.app.version,
      signal: stopper.signal,
    })
    io.setExitCode(0)
  } finally {
    io.signals.off("SIGINT", stop).off("SIGTERM", stop)
    unroom()
    unrouteOut()
    unrouteErr()
    if (stdin)
      Object.defineProperty(process, "stdin", stdin)
      // An idle end leaves stdin open, which would keep the process alive.
    ;(requests as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
    release()
  }
}
