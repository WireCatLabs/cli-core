import { AsyncLocalStorage } from "node:async_hooks"
import { createInterface } from "node:readline"
import { CliError, errorObjectOf, renderError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { commandPathOf } from "./command-contract.js"
import { isCommandServer } from "./command-server-argv.js"
import { stdinFieldOf } from "./stdin-field.js"

export const COMMAND_SERVER_PROTOCOL = 1
/** An updated tool's old code must not answer for long. */
export const COMMAND_SERVER_IDLE_MS = 10 * 60_000

const requests = new AsyncLocalStorage<true>()

export const inCommandServerRequest = <T>(work: () => T): T => requests.run(true, work)

/** A command the server cannot answer like a spawned run: one that never returns, waits on a person, or reads stdin. */
export const refuseInCommandServer = (command: Command, cli: string): void => {
  if (requests.getStore() !== true) return
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
  run: (argv: string[]) => Promise<CommandAnswer>
  cli: string
  version: string
  idleMs?: number
  /** Ends the server after the request under way. */
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
 * Says it is ready, then answers each line of `input` in order, one at a time: two runs at once in one process would
 * open the store twice, and closing either descriptor drops the other's locks (BUG-557). Resolves with 0 when the
 * input ends or nothing came for `idleMs`.
 */
export const serveCommands = async ({
  input,
  write,
  run,
  cli,
  version,
  idleMs = COMMAND_SERVER_IDLE_MS,
  signal,
}: ServeOptions): Promise<number> => {
  const send = (value: object) => write(`${JSON.stringify(value)}\n`)
  await send({ ready: true, protocol: COMMAND_SERVER_PROTOCOL, version })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  return new Promise<number>((resolve) => {
    let queue = Promise.resolve()
    let waiting = 0
    let timer: NodeJS.Timeout | undefined
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      lines.close()
      resolve(0)
    }
    const idle = () => {
      clearTimeout(timer)
      timer = setTimeout(finish, idleMs)
    }
    const answer = async (line: string) => {
      const request = requestOf(line, cli)
      if ("error" in request) return send({ id: request.id, code: 2, stdout: "", stderr: refusal(cli, request.error) })
      const answered = await run(request.argv)
      return send({ id: request.id, ...answered })
    }
    lines.on("line", (line) => {
      if (done || line.trim() === "") return
      waiting += 1
      clearTimeout(timer)
      queue = queue
        .then(() => answer(line))
        .catch(finish)
        .then(() => {
          waiting -= 1
          if (waiting === 0 && !done) idle()
        })
    })
    lines.on("close", () => {
      queue = queue.then(finish)
    })
    if (signal?.aborted) finish()
    signal?.addEventListener("abort", () => (queue = queue.then(finish)), { once: true })
    idle()
  })
}
