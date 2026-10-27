import { randomUUID } from "node:crypto"
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server"
import { toJsonSchema, toStandardJsonSchema } from "@valibot/to-json-schema"
import { CliError } from "@wirecat/cli-base"
import type { CommandOutput } from "@wirecat/cli-base/commands"
import * as v from "valibot"
import { answerSchema, listOf } from "../cli/envelope.js"
import { ENTITIES, type EntityName } from "../entities/index.js"
import type { AppErrors } from "../errors/reasons.js"
import type { CommandAvailability } from "./agent.js"
import { type CallerSource, callerOf, currentCaller, withCaller } from "./caller.js"
import { agentArguments } from "./text.js"
import {
  type AnyTool,
  answered,
  commandOf,
  entryRunner,
  failed,
  inputOf,
  outputSchemaOf,
  READ,
  type Registration,
  syncAllowedFor,
  UNTRUSTED,
  UNTRUSTED_NEUTRAL,
  WRITE,
} from "./tool.js"

const MATCHES = 8
const ANSWER = answerSchema()

type Input = v.ObjectSchema<v.ObjectEntries, undefined> | v.StrictObjectSchema<v.ObjectEntries, undefined>

/** One command an agent can find and run: its arguments are checked against `input` before `run`. */
export interface McpCommand {
  availability?: () => CommandAvailability
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

export const normal = (command: string): string =>
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

const takesNothing = (one: McpCommand): boolean =>
  Object.values(one.input.entries).every((entry) => entry.type === "optional")

/** A reading command an agent can run as it is, a listing first: the example in the call's description. */
const sampleOf = (commands: Record<string, McpCommand>): string => {
  const reading = Object.entries(commands).filter(([, one]) => !one.writes)
  const bare = reading.filter(([, one]) => takesNothing(one))
  return (
    bare.find(([command]) => command.endsWith(" list"))?.[0] ??
    bare[0]?.[0] ??
    reading[0]?.[0] ??
    Object.keys(commands)[0] ??
    ""
  )
}

/**
 * **Three tools in place of one per command** (CLI-74, NEED-766): search the commands, then run one
 * with `read` or `write`. A command keeps its CLI path and its arguments, and runs as its own tool
 * did. The catalogue stays discoverable; current permissions annotate availability and are checked before execution.
 */
export const registerCommands = (
  server: McpServer,
  prefix: string,
  commands: Record<string, McpCommand>,
  errors?: AppErrors,
  /** Throws the refusal of a command left out because the lock or a level stops it, so the agent learns why. */
  withheld?: (command: string) => void,
  /** `AppIdentity.messenger`; left out, a catalogue with `messages` commands is taken for a messenger's. */
  isMessenger?: boolean,
) => {
  const byNormal = new Map(Object.keys(commands).map((command) => [normal(command), command]))
  const messenger = isMessenger ?? Object.keys(commands).some((command) => command.split(" ")[0] === "messages")
  const tasks = messenger ? '"unread", "send message", "chat members"' : '"list", "show", "change a setting"'
  const sample = messenger ? "messages list" : sampleOf(commands)
  const untrusted = messenger ? UNTRUSTED : UNTRUSTED_NEUTRAL

  server.registerTool(
    `${prefix}_tools_search`,
    {
      outputSchema: toStandardJsonSchema(v.looseObject({})),
      title: "Find a command",
      description:
        `Find the command for a task — ${tasks} — before calling ` +
        `${prefix}_read or ${prefix}_write with it. Each match gives its command, whether it writes, its arguments and the shape of its answer. ` +
        "With no words, lists every command and title, without arguments.",
      inputSchema: toStandardJsonSchema(
        v.strictObject({ query: v.optional(v.pipe(v.string(), v.description("words that describe the task"))) }),
      ),
      annotations: { ...READ, openWorldHint: false, idempotentHint: true },
    },
    async ({ query }: { query?: string }) => {
      const found = search(commands, query ?? "")
      const items = query?.trim()
        ? found.slice(0, MATCHES).map(([command, one]) => ({
            command,
            title: one.title,
            description: one.description,
            writes: one.writes,
            availability: one.availability?.() ?? { available: true },
            arguments: toJsonSchema(one.input),
            output: toJsonSchema(one.output ?? ANSWER),
          }))
        : found.map(([command, one]) => ({
            command,
            title: one.title,
            writes: one.writes,
            availability: one.availability?.() ?? { available: true },
          }))
      // The tool takes no page: more matches mean narrower words, so the list carries no page.next to rerun.
      const { next: _paging, ...list } = listOf(`${prefix}_tools_search`, {
        items,
        limit: Math.max(items.length, query?.trim() ? MATCHES : 1),
        has_more: found.length > items.length,
      })
      return answered(list)
    },
  )

  // A CLI's own server runs in its own process: its environment names the agent that started it on stdio.
  const callers: CallerSource = {
    env: process.env,
    client: () => server.server.getClientVersion(),
    connectionId: randomUUID(),
  }
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
          withheld?.(normal(asked))
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
        const caller = currentCaller() ?? callerOf(ctx, command.replace(/[ -]/g, "_"), callers)
        if (one.checked)
          return runnableOnly(await withCaller(caller, () => one.run(args, ctx)), (named) =>
            byNormal.has(normal(named)),
          )
        const parsed = v.safeParse(v.strictObject(one.input.entries), args)
        if (!parsed.success)
          throw new CliError("validation_error", `${command}: ${v.summarize(parsed.issues)}`, {
            arguments: toJsonSchema(one.input),
          })
        return runnableOnly(
          await withCaller(caller, () => one.run(parsed.output as Record<string, unknown>, ctx)),
          (named) => byNormal.has(normal(named)),
        )
      } catch (error) {
        return failed(error, errors)
      }
    }

  const call = v.strictObject({
    command: v.pipe(
      v.string(),
      v.minLength(1),
      v.description(`a command ${prefix}_tools_search returned: "${sample}"`),
    ),
    arguments: v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description("that command's arguments"))),
  })
  server.registerTool(
    `${prefix}_read`,
    {
      outputSchema: toStandardJsonSchema(ANSWER),
      title: "Run a reading command",
      description: `Run one command that only reads, with the arguments ${prefix}_tools_search showed. ${untrusted}`,
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
        description: `Run one command that changes something — ${messenger ? "sends, edits, deletes, joins" : "creates, edits, deletes"} — with the arguments ${prefix}_tools_search showed. ${untrusted}`,
        inputSchema: toStandardJsonSchema(call),
        annotations: WRITE,
      },
      runner(true),
    )
}

/** The definitions no command answers — a picture for the model, the server's own status — as commands. */
export const surfaceCommands = (
  tools: Record<string, AnyTool>,
  registration: Registration,
): Record<string, McpCommand> => {
  const run = entryRunner(registration)
  return Object.fromEntries(
    Object.entries(tools).map(([key, definition]) => [
      commandOf(key, definition),
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
  )
}

/** The envelope a command answers with, from the entity it declares (`annotate(…, { output })`). */
export const outputOf = ({ entity, view }: CommandOutput): v.GenericSchema =>
  answerSchema(
    (ENTITIES[(view ? `${entity}.${view}` : entity) as EntityName] as v.GenericSchema | undefined) ?? v.unknown(),
  )
