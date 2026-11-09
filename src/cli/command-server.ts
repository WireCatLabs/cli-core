import { createInterface } from "node:readline"
import { CliError, errorObjectOf, renderError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { commandPathOf } from "./command-contract.js"
import { isCommandServer } from "./command-server-argv.js"
import { commandServerRequest } from "./command-server-request.js"
import { stdinFieldOf } from "./stdin-field.js"

export const COMMAND_SERVER_PROTOCOL = 1
/** An updated tool's old code must not answer for long. */
export const COMMAND_SERVER_IDLE_MS = 10 * 60_000
/** Requests one server runs at once; Desktop's Memory page asks for 7 reads together. */
export const COMMAND_SERVER_CONCURRENT = 8

// They swap or rewrite the store's file, which the connections of the other requests in this process hold open.
const runsAlone = (command: Command): boolean => commandPathOf(command)[0] === "store"

/**
 * Refuses inside a request a command that never returns, waits on a person, or reads stdin; a `store` command then
 * waits until it is the only request running.
 */
export const enterCommandServer = async (command: Command, cli: string): Promise<void> => {
  const request = commandServerRequest()
  if (!request) return
  refuseInCommandServer(command, cli)
  if (runsAlone(command)) await request.alone()
}

/** A command the server cannot answer like a spawned run: one that never returns, waits on a person, or reads stdin. */
export const refuseInCommandServer = (command: Command, cli: string): void => {
  if (!commandServerRequest()) return
  const typed = [cli, ...commandPathOf(command)].join(" ")
  const { lifetime } = metaOf(command)
  if (lifetime)
    throw new CliError(
      "validation_error",
      `\`${typed}\` ${lifetime === "persistent" ? "runs until it is stopped" : "waits on a person"}; ` +
        "the command server runs only commands that return — start it as a process of its own",
    )
  if (stdinFieldOf(command))
    throw new CliError(
      "validation_error",
      `\`${typed}\` reads its input on stdin, which the command server does not pass on — start it as a process of its own`,
    )
}

export interface CommandAnswer {
  code: number
  stdout: string
  stderr: string
}

export interface ServeOptions {
  input: NodeJS.ReadableStream
  /** One protocol line, the newline included; resolves once it may be written again. */
  write: (line: string) => Promise<void>
  /** `alone` resolves once no other request runs; new requests wait until this one ends. */
  run: (argv: string[], alone: () => Promise<void>) => Promise<CommandAnswer>
  cli: string
  version: string
  idleMs?: number
  concurrent?: number
  /** Ends the server after the requests under way. */
  signal?: AbortSignal
}

const refusal = (cli: string, message: string): string =>
  `${renderError(errorObjectOf(new CliError("validation_error", message)), { cli, interactive: false })}\n`

const requestOf = (
  line: string,
  cli: string,
): { id: number; argv: string[] } | { id: number | null; error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { id: null, error: "a request is one JSON object per line" }
  }
  const { id, argv } = (parsed ?? {}) as { id?: unknown; argv?: unknown }
  // A request whose id is readable is answered under it, so the client never waits on it.
  const known = typeof id === "number" && Number.isFinite(id) ? id : null
  if (known === null) return { id: null, error: 'a request needs a numeric "id"' }
  if (!Array.isArray(argv) || !argv.every((word) => typeof word === "string"))
    return { id: known, error: '"argv" is a list of strings' }
  if (isCommandServer(argv)) return { id: known, error: `\`${cli} commands --serve\` cannot run inside itself` }
  return { id: known, argv }
}

/**
 * Says it is ready, then runs up to `concurrent` requests at once and answers each as it ends, under its `id`. SQLite
 * keeps the requests' connections apart in one process; a `store` command, which swaps the file, runs alone. Resolves
 * with 0 once the input ends or nothing came for `idleMs`, after the requests under way.
 */
export const serveCommands = async ({
  input,
  write,
  run,
  cli,
  version,
  idleMs = COMMAND_SERVER_IDLE_MS,
  concurrent = COMMAND_SERVER_CONCURRENT,
  signal,
}: ServeOptions): Promise<number> => {
  const send = (value: object) => write(`${JSON.stringify(value)}\n`)
  await send({ ready: true, protocol: COMMAND_SERVER_PROTOCOL, version, concurrent })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  return new Promise<number>((resolve) => {
    const waiting: string[] = []
    // Started and not answered; `running` leaves out a request waiting to run alone, which holds no place.
    let active = 0
    let running = 0
    let gated = false
    let drained: (() => void) | undefined
    let turns = Promise.resolve()
    let timer: NodeJS.Timeout | undefined
    let ending = false
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      lines.close()
      resolve(0)
    }
    const settle = () => {
      if (running === 0 && drained) {
        const go = drained
        drained = undefined
        go()
      }
      pump()
      if (active > 0 || waiting.length > 0 || done) return
      if (ending) finish()
      else {
        clearTimeout(timer)
        timer = setTimeout(finish, idleMs)
      }
    }
    const start = (line: string) => {
      active += 1
      running += 1
      let release: (() => void) | undefined
      const alone = () => {
        if (release) return Promise.resolve()
        running -= 1
        const turn = turns.then(
          () =>
            new Promise<void>((go) => {
              gated = true
              drained = () => {
                running += 1
                go()
              }
              settle()
            }),
        )
        turns = turn.then(() => new Promise<void>((free) => (release = free)))
        return turn
      }
      const answer = async () => {
        const request = requestOf(line, cli)
        if ("error" in request)
          return send({ id: request.id, code: 2, stdout: "", stderr: refusal(cli, request.error) })
        const answered = await run(request.argv, alone)
        return send({ id: request.id, ...answered })
      }
      answer()
        .catch(finish)
        .finally(() => {
          active -= 1
          running -= 1
          if (release) {
            gated = false
            release()
          }
          settle()
        })
    }
    const pump = () => {
      while (!done && !gated && running < concurrent && waiting.length > 0) start(waiting.shift() as string)
    }
    lines.on("line", (line) => {
      if (done || ending || line.trim() === "") return
      clearTimeout(timer)
      waiting.push(line)
      pump()
    })
    const end = () => {
      ending = true
      settle()
    }
    lines.on("close", end)
    if (signal?.aborted) end()
    signal?.addEventListener("abort", end, { once: true })
    settle()
  })
}
