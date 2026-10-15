import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server"
import { toJsonSchema, toStandardJsonSchema } from "@valibot/to-json-schema"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { answerSchema } from "../cli/envelope.js"
import { movedPath, movedPointer } from "../cli/moved.js"
import type { AppErrors } from "../errors/reasons.js"
import { agentArguments } from "./text.js"
import {
  type AnyTool,
  answered,
  entryRunner,
  failed,
  inputOf,
  outputSchemaOf,
  READ,
  type Registration,
  syncAllowedFor,
  UNTRUSTED,
  WRITE,
} from "./tool.js"

const MATCHES = 8
const ANSWER = answerSchema()

type Input = v.ObjectSchema<v.ObjectEntries, undefined> | v.StrictObjectSchema<v.ObjectEntries, undefined>

/** One command an agent can find and run: its arguments are checked against `input` before `run`. */
export interface McpCommand {
  title: string
  description: string
  writes: boolean
  input: Input
  /** The envelope it answers with, when it declares its entity; any envelope otherwise. */
  output?: v.GenericSchema
  /** `run` checks the arguments itself, and records a refusal. */
  checked?: boolean
  run: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>
}

/** `chats_mark_read` is `chats mark-read`: the one verb with a hyphen. */
export const commandOf = (key: string): string => key.replaceAll("_", " ").replace("mark read", "mark-read")

const normal = (command: string): string =>
  command
    .trim()
    .toLowerCase()
    .split(/[\s_-]+/)
    .join(" ")

const haystack = (command: string, one: McpCommand): string =>
  [command, one.title, one.description, ...Object.keys(one.input.entries)].join(" ").toLowerCase()

/**
 * Every query word must appear. The command named exactly ranks first, then whole words of the command,
 * then parts of them. No word lists everything.
 */
export const search = (commands: Record<string, McpCommand>, query: string): [string, McpCommand][] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return Object.entries(commands)
    .filter(([command, one]) => words.every((word) => haystack(command, one).includes(word)))
    .map((entry) => {
      const parts = entry[0].split(/[\s-]/)
      const exact = entry[0] === words.join(" ") ? 100 : 0
      const whole = words.filter((word) => parts.includes(word)).length * 10
      return { entry, rank: exact + whole + words.filter((word) => entry[0].includes(word)).length }
    })
    .sort((a, b) => b.rank - a.rank || a.entry[0].localeCompare(b.entry[0]))
    .map(({ entry }) => entry)
}

const nearest = (commands: Record<string, McpCommand>, asked: string): string[] => {
  const words = normal(asked).split(" ")
  return Object.keys(commands)
    .map((one) => ({ one, shared: words.filter((word) => normal(one).split(" ").includes(word)).length }))
    .filter(({ shared }) => shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3)
    .map(({ one }) => one)
}

/** A `next` step names a command this server offers, or it is dropped: the profile may not offer every command. */
const runnableOnly = (result: CallToolResult, offered: (command: string) => boolean): CallToolResult => {
  const body = result.structuredContent as { next?: { command: string }[] } | undefined
  if (result.isError || !Array.isArray(body?.next)) return result
  const next = body.next.filter((step) => offered(step.command))
  const { next: _, ...rest } = body
  const kept = next.length > 0 ? { ...rest, next } : rest
  return {
    ...result,
    structuredContent: kept,
    content: result.content.map((part) => (part.type === "text" ? { ...part, text: JSON.stringify(kept) } : part)),
  }
}

/**
 * **Three tools in place of one per command** (CLI-74, NEED-766): search the commands, then run one
 * with `read` or `write`. A command keeps its CLI path and its arguments, and runs as its own tool
 * did. The list never changes during a connection; what a profile may not use is not in `commands`.
 */
export const registerCommands = (
  server: McpServer,
  prefix: string,
  commands: Record<string, McpCommand>,
  errors?: AppErrors,
) => {
  const byNormal = new Map(Object.keys(commands).map((command) => [normal(command), command]))

  server.registerTool(
    `${prefix}_tools_search`,
    {
      outputSchema: toStandardJsonSchema(v.looseObject({})),
      title: "Find a command",
      description:
        `Find the command for a task — "unread", "send message", "chat members" — before calling ` +
        `${prefix}_read or ${prefix}_write with it. Each match gives its command, whether it writes, its arguments and the shape of its answer. ` +
        "With no words, lists every command and title, without arguments.",
      inputSchema: toStandardJsonSchema(
        v.strictObject({ query: v.optional(v.pipe(v.string(), v.description("words that describe the task"))) }),
      ),
      annotations: { ...READ, openWorldHint: false, idempotentHint: true },
    },
    async ({ query }: { query?: string }) => {
      const found = search(commands, query ?? "")
      return answered(
        query?.trim()
          ? {
              items: found.slice(0, MATCHES).map(([command, one]) => ({
                command,
                title: one.title,
                description: one.description,
                writes: one.writes,
                arguments: toJsonSchema(one.input),
                output: toJsonSchema(one.output ?? ANSWER),
              })),
              more: found.length > MATCHES,
            }
          : { items: found.map(([command, one]) => ({ command, title: one.title, writes: one.writes })) },
      )
    },
  )

  const runner =
    (writing: boolean) =>
    async (
      { command: asked, arguments: given }: { command: string; arguments?: Record<string, unknown> },
      ctx: ServerContext,
    ) => {
      try {
        const command = byNormal.get(normal(asked))
        const one = command === undefined ? undefined : commands[command]
        if (command === undefined || !one) {
          const moved = movedPath(normal(asked).split(" "), (path) => byNormal.has(path))
          if (moved !== undefined)
            throw new CliError("validation_error", `no command "${asked}" here — ${movedPointer(moved)}`)
          const near = nearest(commands, asked)
          throw new CliError(
            "validation_error",
            `no command "${asked}" here${near.length ? ` — did you mean ${near.map((name) => `"${name}"`).join(", ")}?` : ""}; ${prefix}_tools_search finds one`,
          )
        }
        if (one.writes !== writing)
          throw new CliError(
            "validation_error",
            `"${command}" ${writing ? "only reads" : "writes"}: call it with ${prefix}_${writing ? "read" : "write"}`,
          )
        const args = writing ? agentArguments(given ?? {}) : (given ?? {})
        if (one.checked) return runnableOnly(await one.run(args, ctx), (named) => byNormal.has(normal(named)))
        const parsed = v.safeParse(v.strictObject(one.input.entries), args)
        if (!parsed.success)
          throw new CliError("validation_error", `${command}: ${v.summarize(parsed.issues)}`, {
            arguments: toJsonSchema(one.input),
          })
        return runnableOnly(await one.run(parsed.output as Record<string, unknown>, ctx), (named) =>
          byNormal.has(normal(named)),
        )
      } catch (error) {
        return failed(error, errors)
      }
    }

  const call = v.strictObject({
    command: v.pipe(
      v.string(),
      v.minLength(1),
      v.description(`a command ${prefix}_tools_search returned: "messages list"`),
    ),
    arguments: v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description("that command's arguments"))),
  })
  server.registerTool(
    `${prefix}_read`,
    {
      outputSchema: toStandardJsonSchema(ANSWER),
      title: "Run a reading command",
      description: `Run one command that only reads, with the arguments ${prefix}_tools_search showed. ${UNTRUSTED}`,
      inputSchema: toStandardJsonSchema(call),
      annotations: READ,
    },
    runner(false),
  )
  if (Object.values(commands).some((one) => one.writes))
    server.registerTool(
      `${prefix}_write`,
      {
        outputSchema: toStandardJsonSchema(ANSWER),
        title: "Run a writing command",
        description: `Run one command that changes something — sends, edits, deletes, joins — with the arguments ${prefix}_tools_search showed. ${UNTRUSTED}`,
        inputSchema: toStandardJsonSchema(call),
        annotations: WRITE,
      },
      runner(true),
    )
}

/** The personal account's definitions as commands, each run through the shared runner. */
export const registerSurface = (server: McpServer, tools: Record<string, AnyTool>, registration: Registration) => {
  const run = entryRunner(registration)
  registerCommands(
    server,
    registration.command,
    Object.fromEntries(
      Object.entries(tools).map(([key, definition]) => [
        commandOf(key),
        {
          title: definition.title,
          description: definition.description,
          writes: definition.annotations.readOnlyHint !== true,
          input: inputOf(definition, syncAllowedFor(key, registration.defaults)),
          ...(definition.output ? { output: outputSchemaOf(definition) } : {}),
          checked: true,
          run: (args, ctx) => run(key, definition, args, ctx),
        } satisfies McpCommand,
      ]),
    ),
    registration.messenger?.app?.errors,
  )
}
