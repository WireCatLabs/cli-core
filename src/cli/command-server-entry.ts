import { PassThrough } from "node:stream"
import { CliError, catchCrashes } from "@wirecat/cli-base"
import { useAsProcessRun } from "../runs/scope.js"
import { ensureSqlite } from "../sqlite-runtime.js"
import { type CommandAnswer, inCommandServerRequest, refuseInCommandServer, serveCommands } from "./command-server.js"
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

const useStdin = (stdin: NodeJS.ReadableStream) =>
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, enumerable: true, writable: true })

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
  let current: { stdout: Buffer[]; stderr: Buffer[] } | undefined
  const unrouteOut = route(process.stdout, () => (current ? (chunk) => current?.stdout.push(chunk) : toStderr))
  const unrouteErr = route(process.stderr, () => (current ? (chunk) => current?.stderr.push(chunk) : toStderr))
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")
  const requests = io.stdin
  useStdin(closedStdin())
  io.signals.on("SIGINT", stop).on("SIGTERM", stop)
  io.stdout.on("error", stop)

  const run = async (argv: string[]): Promise<CommandAnswer> => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    current = { stdout, stderr }
    process.exitCode = undefined
    // Lines written outside a run name the process's run; each request is a process of its own.
    useAsProcessRun(undefined)
    const input = closedStdin()
    useStdin(input)
    const requestIo: EntryIo = { ...io, argv: [...io.argv.slice(0, 2), ...argv], stdin: input }
    const context: EntryContext = {
      args: argv,
      env: io.env,
      tty: false,
      signal: stopper.signal,
      atStart: async (command) => {
        refuseInCommandServer(command, entry.app.command)
        await firstRunAt(entry, requestIo, () => true)(command)
      },
      ask: async () => false,
      openBrowser: async () => undefined,
      outputClosed: () => false,
    }
    let code: number
    try {
      code = await inCommandServerRequest(async () => {
        try {
          const returned = await entry.run(context)
          return typeof returned === "number" ? returned : Number(process.exitCode ?? 0)
        } catch (error) {
          return commanderExit(error) ?? entry.fail(error, context)
        }
      })
    } finally {
      current = undefined
      process.exitCode = undefined
    }
    return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
  }

  try {
    if (entry.sqlite) await ensureSqlite()
    await serveCommands({
      input: requests,
      write: (line) => new Promise((resolve) => (protocol(line) ? resolve() : io.stdout.once("drain", resolve))),
      run,
      cli: entry.app.command,
      version: entry.app.version,
      signal: stopper.signal,
    })
    io.setExitCode(0)
  } finally {
    io.signals.off("SIGINT", stop).off("SIGTERM", stop)
    unrouteOut()
    unrouteErr()
    if (stdin)
      Object.defineProperty(process, "stdin", stdin)
      // An idle end leaves stdin open, which would keep the process alive.
    ;(requests as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
    release()
  }
}
