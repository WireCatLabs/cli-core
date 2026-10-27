import { openSync } from "node:fs"
import { createInterface } from "node:readline"
import { ReadStream } from "node:tty"
import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import type { Asker } from "../../sends/guard.js"
import { skipFlagFor } from "../../sends/permissions.js"
import { environmentOf } from "../context.js"

export { skipFlagFor }

/**
 * One line from the terminal itself, not stdin — stdin may be the text being sent. `null` when no
 * person is there. Ctrl-C and a closed terminal cancel, as `readSecret` does.
 */
const fromTerminal = async (question: string): Promise<string | null> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null
  let input: ReadStream
  try {
    input = new ReadStream(openSync("/dev/tty", "r"))
  } catch {
    return null
  }
  const reader = createInterface({ input, output: process.stderr, terminal: true })
  try {
    return await new Promise<string>((resolve, reject) => {
      const cancel = () => reject(new CliError("cancelled", "cancelled — nothing was done"))
      reader.once("SIGINT", cancel)
      reader.once("close", cancel)
      reader.question(question, resolve)
    })
  } finally {
    reader.close()
    input.destroy()
  }
}

const what = (key: string, { chatId, count, personIds, forEveryone }: Parameters<Asker>[1]) =>
  [
    key,
    forEveryone ? "for everyone" : undefined,
    count !== undefined ? `${count} ${count === 1 ? "item" : "items"}` : undefined,
    personIds?.length ? `${personIds.length} ${personIds.length === 1 ? "person" : "people"}` : undefined,
    chatId !== null ? `in chat ${chatId}` : undefined,
  ]
    .filter(Boolean)
    .join(", ")

/** The owner's answer, or `null` with nobody at a terminal — and always under `--json` or `--jsonl`. */
export const answerOf = async (command: Command, question: string): Promise<string | null> => {
  const given = command.optsWithGlobals<{ json?: boolean; jsonl?: boolean }>()
  if (given.json === true || given.jsonl === true) return null
  return (environmentOf(command).answer ?? fromTerminal)(question)
}

/**
 * For a command a person typed: the flag says yes, or the terminal asks, or nobody can — and it is
 * refused. An agent's run over MCP goes ahead (NEED-773). Never asks under `--json` or `--jsonl`: a program reads those, and a harness that gives
 * an agent a terminal would otherwise wait for ever.
 */
export const terminalAsker =
  (command: Command): Asker =>
  async (key, request) => {
    if (environmentOf(command).agent) return
    const flag = skipFlagFor(key)
    const given = command.optsWithGlobals<{
      yes?: boolean
      allowDangerous?: boolean
      json?: boolean
      jsonl?: boolean
    }>()
    if (flag === "--yes" ? given.yes === true : given.allowDangerous === true) return
    const machine = given.json === true || given.jsonl === true
    const answer = machine
      ? null
      : await (environmentOf(command).answer ?? fromTerminal)(`${what(key, request)} — go ahead? [y/N] `)
    if (answer === null) {
      throw new CliError(
        "confirmation_required",
        `${key} asks before it acts (its permission level is ask), and nobody is at a terminal to answer — ` +
          `add ${flag} to go ahead`,
        { permission: key },
      )
    }
    if (!/^\s*y(es)?\s*$/i.test(answer)) throw new CliError("cancelled", `${key}: not done — the answer was no`)
  }
