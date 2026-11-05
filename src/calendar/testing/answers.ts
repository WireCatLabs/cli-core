import { Command } from "commander"
import * as v from "valibot"
import { answerEntitySchema } from "../../cli/answer-entity.js"
import { provide } from "../../cli/context.js"
import type { AppIdentity } from "../../ports/app.js"
import { addCalendarCommands, type CalendarCommandOptions, type CalendarRun } from "../cli/index.js"

const commandAt = (root: Command, argv: readonly string[]): Command => {
  let at = root
  for (const word of argv) {
    const next = at.commands.find((one) => one.name() === word)
    if (!next) break
    at = next
  }
  return at
}

/** Each item of a printed calendar answer, parsed against the command's declared entity. */
export const checkCalendarAnswer = (root: Command, argv: readonly string[], envelope: unknown): void => {
  const command = commandAt(root, argv)
  const schema = answerEntitySchema(command)
  if (!schema) throw new Error(`${argv.join(" ")} declares no answer entity`)
  const body = envelope as { items?: unknown[]; item?: unknown }
  for (const item of body.items ?? [body.item]) {
    const parsed = v.safeParse(schema, item)
    if (!parsed.success)
      throw new Error(
        `${argv.join(" ")}: ${parsed.issues.map((issue) => `${v.getDotPath(issue) ?? ""} ${issue.message}`).join("; ")}`,
      )
  }
}

export const CALENDAR_TEST_APP: AppIdentity = {
  command: "gcal",
  appName: "gcal-cli",
  envPrefix: "GCAL",
  description: "synthetic",
  version: "1.0.0",
}

/** A printed answer: an item's fields beside `meta` and `next`, or the list's `items` and `page`. */
export type CalendarAnswer = Record<string, unknown> & {
  items: Record<string, unknown>[]
  meta: Record<string, unknown>
}

export interface CalendarTestProgram {
  root: Command
  /** Runs the words with `--json` and gives what was printed, its item spread at the top; checked by its entity. */
  cli: (...args: string[]) => Promise<CalendarAnswer>
  /** Runs the words as a person at a terminal would, and gives the text printed. */
  text: (...args: string[]) => Promise<string>
  /** Every line on stderr. */
  stderr: string[]
  /** How many times the profile was opened, and how. */
  opened: { readOnly: boolean }[]
}

/**
 * The shared calendar commands on a bare program over `run`, as an app mounts them, printing to captured streams. A
 * test of the commands themselves; an app's own tests go through its `run()`.
 */
export const calendarTestProgram = (
  run: CalendarRun,
  options: Partial<CalendarCommandOptions> = {},
): CalendarTestProgram => {
  const stderr: string[] = []
  const opened: { readOnly: boolean }[] = []
  let data = ""
  const build = (tty = false) => {
    const root = new Command("gcal")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
      .option("--jsonl")
      .option("--offline")
      .option("--full")
      .option("--timeout <duration>")
      .option("--yes")
      .option("--dry-run")
    addCalendarCommands(root, {
      app: CALENDAR_TEST_APP,
      open: async (_command, access) => {
        opened.push(access)
        return run
      },
      now: () => Date.now(),
      timezone: "UTC",
      // A help example names a file; no test writes into the working folder.
      readFile: async () => "",
      writeFile: async () => undefined,
      ...options,
    })
    provide(root, {
      streams: {
        data: (text: string) => {
          data += text
        },
        diagnostic: (text: string) => {
          stderr.push(text)
        },
      },
      tty,
    } as never)
    return root
  }
  const root = build()
  const cli = async (...args: string[]) => {
    const fresh = build()
    data = ""
    const dashes = args.indexOf("--")
    const argv = args.includes("--json")
      ? args
      : dashes < 0
        ? [...args, "--json"]
        : [...args.slice(0, dashes), "--json", ...args.slice(dashes)]
    await fresh.parseAsync(argv, { from: "user" })
    if (!data.trim()) throw new Error(`${args.join(" ")} printed nothing`)
    const envelope = JSON.parse(data) as Record<string, unknown> & { item?: Record<string, unknown> }
    // A --dry-run preview answers what would happen, not the command's entity.
    if (!args.includes("--dry-run")) checkCalendarAnswer(fresh, args, envelope)
    // The run's own facts differ every run; a test compares the rest.
    const { item, meta, ...rest } = envelope as typeof envelope & { meta: Record<string, unknown> }
    const { run_id: _run, duration_ms: _duration, ...facts } = meta
    return { ...(item ?? {}), ...rest, meta: facts } as CalendarAnswer
  }
  const text = async (...args: string[]) => {
    data = ""
    await build(true).parseAsync(args, { from: "user" })
    return data
  }
  return { root, cli, text, stderr, opened }
}
