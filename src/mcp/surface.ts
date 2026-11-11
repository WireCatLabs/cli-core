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

// The listing shows an agent only what it acts on; the server still checks every answer against the full envelope,
// and tools_search gives each command's full answer. meta.ranking alone took 2,800 characters of every connect.
const agentAnswer = (prefix: string, writes: boolean) => {
  const meta = v.pipe(v.looseObject({}), v.description(`run facts; ${prefix}_tools_search shows the full answer`))
  const next = v.optional(v.pipe(v.array(v.looseObject({})), v.description("steps to run next: command and args")))
  return v.looseObject(
    writes
      ? { item: v.optional(v.unknown()), next, meta }
      : {
          items: v.optional(v.array(v.unknown())),
          item: v.optional(v.unknown()),
          page: v.optional(v.looseObject({ has_more: v.boolean() })),
          next,
          missing: v.optional(v.array(v.looseObject({ field: v.string(), why: v.string() }))),
          meta,
        },
  )
}

const listedAs = (prefix: string, writes: boolean) => {
  const checked = toStandardJsonSchema(ANSWER)
  const shown = toStandardJsonSchema(agentAnswer(prefix, writes))["~standard"].jsonSchema
  return { "~standard": { ...checked["~standard"], jsonSchema: shown } }
}

type Input = v.ObjectSchema<v.ObjectEntries, undefined> | v.StrictObjectSchema<v.ObjectEntries, undefined>

/** One command an agent can find and run: its arguments are checked against `input` before `run`. */
export interface McpCommand {
  availability?: () => CommandAvailability
  title: string
  description: string
  /** Other names the command answers to, found by search as its own name is. */
  aliases?: readonly string[]
  /** Words of its help's examples: an agent's task often uses them, not the command's. */
  keywords?: readonly string[]
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

// Words that carry no task: an agent's phrase keeps its nouns and verbs, which the commands' own words are made of.
const STOP_WORDS = new Set(
  (
    "a an the to of in on at by for from with into out about and or but is are be been was were it its this that " +
    "these those which who whom whose what when where how do does did can could should would will my our your their " +
    "his her them they we you i one some any all each every another other"
  ).split(" "),
)

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

/** A plural, a possessive or a past tense names the same thing: `deals` is `deal`, `ended` is `end`. */
const stem = (word: string): string => {
  const bare = word.replace(/'s$/u, "")
  if (bare.length > 4 && bare.endsWith("ies")) return `${bare.slice(0, -3)}y`
  for (const ending of ["ing", "ed", "es", "s"])
    if (bare.length - ending.length >= 3 && bare.endsWith(ending)) return bare.slice(0, -ending.length)
  return bare
}

const sameWord = (asked: string, known: string): boolean => {
  if (asked === known) return true
  const [short, long] = asked.length <= known.length ? [asked, known] : [known, asked]
  return short.length >= 3 && long.startsWith(short)
}

/** Where a word of the task is found, by how much it says about the command: its own name says the most. */
const fieldsOf = (command: string, one: McpCommand): [number, string[]][] =>
  [
    [4, [...wordsOf(command), ...(one.aliases ?? []).flatMap(wordsOf)]],
    [2, wordsOf(one.title)],
    [1, [...wordsOf(one.description), ...(one.keywords ?? []).flatMap(wordsOf), ...Object.keys(one.input.entries)]],
  ].map(([weight, words]) => [weight as number, [...new Set((words as string[]).map(stem))]])

/**
 * Ranks by how many words of the task a command matches, then by where they matched: its name, then its title, then
 * its help, examples and arguments. A task is typed in its own words, so no single word is required. The command
 * named exactly ranks first. No word lists everything.
 */
export const search = (commands: Record<string, McpCommand>, query: string): [string, McpCommand][] => {
  const named = normal(query)
  const all = Object.entries(commands)
  if (!named) return all.map((entry) => entry).sort((a, b) => a[0].localeCompare(b[0]))
  const words = [
    ...new Set(
      wordsOf(query)
        .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
        .map(stem),
    ),
  ]
  return all
    .map((entry) => {
      const fields = fieldsOf(entry[0], entry[1])
      const weights = words.map((word) =>
        fields.reduce(
          (best, [weight, known]) => (known.some((one) => sameWord(word, one)) ? Math.max(best, weight) : best),
          0,
        ),
      )
      const matched = weights.filter((weight) => weight > 0).length
      const exact = normal(entry[0]) === named || (entry[1].aliases ?? []).some((alias) => normal(alias) === named)
      return { entry, matched, rank: (exact ? 1000 : 0) + matched * 10 + weights.reduce((a, b) => a + b, 0) }
    })
    .filter(({ matched, rank }) => matched > 0 || rank >= 1000)
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
  const body = result.structuredContent as { next?: { command?: string }[] } | undefined
  if (result.isError || !Array.isArray(body?.next)) return result
  const next = body.next.filter((step) => step.command === undefined || offered(step.command))
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
      outputSchema: listedAs(prefix, false),
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
        outputSchema: listedAs(prefix, true),
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
