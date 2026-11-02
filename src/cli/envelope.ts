import { exitCodeOfAnswer, type Renderer, type RenderFormat, type Streams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import {
  COMPACT_FLAG,
  type ItemEnvelope,
  itemEnvelopeSchema,
  jsonlOf,
  type ListEnvelope,
  listEnvelopeSchema,
  MAX_NEXT_STEPS,
  type Meta,
  type Missing,
  type NextStep,
  type StepInput,
  type Total,
} from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import * as v from "valibot"
import { currentRun } from "../runs/scope.js"
import { compactText, rowShapeOf, TEXT_CHARS } from "./compact.js"
import { environmentOf, setExitCode } from "./context.js"
import { withoutProviderRefs } from "./provider-refs.js"
import { nextStep, rootOf, runnable, stepLine, withLines, withSafety } from "./steps.js"

export type ListBody<T> = Omit<ListEnvelope<T>, "meta"> & { meta?: Partial<Meta> }
export type ItemBody<T> = Omit<ItemEnvelope<T>, "meta"> & { meta?: Partial<Meta> }
export type Body<T = unknown> = ListBody<T> | ItemBody<T>

export interface ListInput<T> {
  items: T[]
  limit: number
  has_more: boolean
  /** Where the next page starts, for a source that pages by its own position; absent on the last page. */
  cursor?: string
  /** The source pages by position, not number: set it so the last page, which has no cursor, says so too. */
  paging?: "cursor"
  /** The page shown, from 1, for a list paged by `--page`. */
  page?: number
  /** How many match, every page together, for a search that counts them. */
  total?: Total
  /** The command's own arguments and query, so `page.next` reruns the same list. */
  args?: Record<string, unknown>
  next?: NextStep[]
  missing?: Missing[]
  meta?: Partial<Meta>
}

/** Every answer: a list or one thing, with items of `item` — any value where the command declares no entity. */
export const answerSchema = (item: v.GenericSchema = v.unknown()) =>
  v.union([listEnvelopeSchema(item), itemEnvelopeSchema(item)])

const capped = (steps: NextStep[]) => (steps.length > 0 ? { next: steps.slice(0, MAX_NEXT_STEPS) } : {})

/**
 * A list answer. When more rows exist, `page.next` comes first: rerun `command` from the cursor, or the next
 * page where the source has no cursor.
 */
export const listOf = <T>(command: string, input: ListInput<T>): ListBody<T> => {
  const { items, limit, has_more, cursor, paging, page, total, args = {}, next = [], missing, meta } = input
  const byCursor = paging === "cursor" || cursor !== undefined
  const more = has_more
    ? [
        nextStep("page.next", {
          command,
          args: { ...args, ...(cursor === undefined ? { page: (page ?? 1) + 1, limit } : { cursor, limit }) },
          values: { shown: items.length },
        }),
      ]
    : []
  const body: ListBody<T> = {
    items,
    page: byCursor
      ? {
          mode: "cursor",
          limit,
          has_more,
          ...(has_more && cursor !== undefined ? { next_cursor: cursor } : {}),
          ...(total ? { total } : {}),
        }
      : {
          mode: "page",
          limit,
          has_more,
          ...(has_more ? { next_page: (page ?? 1) + 1 } : {}),
          ...(total ? { total } : {}),
        },
    ...capped([...more, ...next]),
    ...(missing && missing.length > 0 ? { missing } : {}),
    ...(meta ? { meta } : {}),
  }
  return body
}

export const itemOf = <T>(
  item: T,
  { next = [], missing, meta }: { next?: NextStep[]; missing?: Missing[]; meta?: Partial<Meta> } = {},
): ItemBody<T> => {
  const body: ItemBody<T> = {
    item,
    ...capped(next),
    ...(missing && missing.length > 0 ? { missing } : {}),
    ...(meta ? { meta } : {}),
  }
  return body
}

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/**
 * `snakeKeys` that keeps everything under the listed keys as written: a note's front matter, an email's headers — the
 * owner's or a provider's words, not field names. The key itself still goes snake_case; either spelling matches.
 */
export const snakeKeysKeeping = (verbatim: Iterable<string>): ((value: unknown) => unknown) => {
  const kept = new Set(verbatim)
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert)
    if (value === null || typeof value !== "object" || value.constructor !== Object) return value
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, inner]) => {
        if (inner === undefined) return []
        const name = snake(key)
        return [[name, kept.has(key) || kept.has(name) ? inner : convert(inner)]]
      }),
    )
  }
  return convert
}

/**
 * An answer that has no entity yet — a write's receipt, a count — with snake_case keys, nested ones too.
 * Only for records whose keys are field names; a record keyed by data goes through `snakeKeysKeeping`.
 */
export const snakeKeys = snakeKeysKeeping([])

/**
 * The envelope's shape, not where it was built: an answer an app reshaped (snake_case, `--json=a,b`) or parsed from
 * another command's output is still one.
 */
export const isBody = (value: unknown): value is Body => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if ("item" in value) return true
  return (
    "items" in value &&
    Array.isArray(value.items) &&
    "page" in value &&
    typeof value.page === "object" &&
    value.page !== null
  )
}

/** A programming error: every answer goes out as `item` or `items` + `page`, built by `itemOf` or `listOf`. */
const refuse = (value: unknown): never => {
  const keys = typeof value === "object" && value !== null ? Object.keys(value).join(", ") : typeof value
  throw new Error(`not an answer envelope (keys: ${keys}) — build it with itemOf or listOf`)
}

/** The answer with each next step judged by `targets` — for MCP, which prints no command line to check them by. */
export const judgedAnswer = <T>(value: T, targets: NonNullable<StepInput["targets"]>): T => {
  if (!isBody(value)) return refuse(value)
  if (!value.next) return value
  return { ...value, next: withSafety(value.next, targets) } as T
}

/** `meta` from the run the answer belongs to, so `runs show <run_id>` finds it. Complete unless it names an issue. */
export const metaNow = (extra: Partial<Meta> = {}): Meta => {
  const run = currentRun()
  return {
    run_id: run.runId,
    duration_ms: Math.max(0, Math.round(Date.now() - (run.startedAt ?? Date.now()))),
    ...extra,
    complete: extra.complete ?? !extra.issues?.length,
  }
}

/** The one place an answer gets its `meta`, for the CLI and MCP alike. */
export const sealed = <T>(value: T): T => {
  if (!isBody(value)) return refuse(value)
  const { meta, ...rest } = withoutProviderRefs(value)
  return { ...rest, meta: metaNow(meta) } as T
}

export interface AnswerOutput {
  renderer: Renderer
  format: RenderFormat
  streams: Streams
  /** One line per item from the same answer (WC-OUT-24); an agent's run keeps JSON. */
  compact?: boolean
  /** With `compact`: each text whole, not cut. */
  full?: boolean
}

/** The steps a compact answer prints, each rerunning in the compact form the caller chose. */
const compactSteps = (root: Command, steps: readonly NextStep[]): NextStep[] =>
  steps.map((step) =>
    step.kind === "command" ? { ...step, line: `${step.line ?? stepLine(root, step)} ${COMPACT_FLAG}` } : step,
  )

/** An answer as JSON lines: one line per item, then the end line. One thing is a list of one that has no more. */
const linesOf = <T>(body: ListEnvelope<T> | ItemEnvelope<T>): string =>
  jsonlOf(
    "items" in body ? body : { items: [body.item], page: { mode: "page", limit: 1, has_more: false }, meta: body.meta },
  )

/** An answer as JSON-lines records, for a writer that streams objects: one per item, then the end record. */
export const jsonlRecords = <T>(body: Body<T>): object[] =>
  linesOf(sealed(body) as ListEnvelope<T> | ItemEnvelope<T>)
    .split("\n")
    .map((line) => JSON.parse(line) as object)

/**
 * Prints an answer. Machine output gets the whole envelope (`--jsonl` the items and an end line); a person gets
 * the items — `view` draws them — and each next step this CLI has, as a line on stderr. A partial answer the
 * command does not declare `partial` exits with its first issue's code, after printing what was read.
 */
export const renderAnswer = <T>(
  command: Command,
  { renderer, format, streams, compact, full }: AnswerOutput,
  body: Body<T>,
  view?: (body: Body<T>) => string,
): void => {
  if (!isBody(body)) refuse(body)
  const root = rootOf(command)
  const runnableSteps = runnable(root, body.next)
  const next = environmentOf(command).agent ? runnableSteps : withLines(root, runnableSteps)
  const kept = withoutProviderRefs({ ...body, ...(next.length > 0 ? { next } : {}) }) as Body<T>
  if (next.length === 0) delete (kept as { next?: unknown }).next
  const whole = sealed(kept) as ListEnvelope<T> | ItemEnvelope<T>
  const drawn = compact && !environmentOf(command).agent
  if (drawn) {
    const lined = whole.next ? { ...whole, next: compactSteps(root, whole.next) } : whole
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    streams.data(compactText(lined, rowShapeOf(command), { timezone, textChars: full ? 0 : TEXT_CHARS }))
  } else if (format === "json") renderer.result(whole)
  else if (format === "jsonl") for (const line of linesOf(whole).split("\n")) streams.data(line)
  else if (view) streams.data(view(kept))
  else renderer.result("items" in kept ? kept.items : kept.item)
  const code = exitCodeOfAnswer(whole.meta, metaOf(command).partial === true)
  if (code !== 0) setExitCode(command, code)
  if (drawn || format === "json") return
  for (const step of next)
    renderer.note(step.kind === "command" ? `→ ${step.why}: ${stepLine(root, step)}` : `→ ${step.why}`)
}

/**
 * A document that is not an answer about the owner's data — the command registry, a `--dry-run` preview of what a
 * command would do — printed whole, with no envelope.
 */
export const renderDocument = ({ renderer }: Pick<AnswerOutput, "renderer">, document: object): void =>
  renderer.result(document)

/** One thing as a sealed `{ item, meta }` answer, for a command that prints without `renderAnswer`'s steps. */
export const itemAnswer = <T>(item: T) => sealed(itemOf(item))

/** Prints one thing: the envelope in `--json`, one record and the end line in `--jsonl`, the thing itself to a person. */
export const printItem = ({ renderer, format }: Pick<AnswerOutput, "renderer" | "format">, item: unknown): void => {
  if (format === "json") renderer.result(itemAnswer(item))
  else if (format === "jsonl") renderer.stream(jsonlRecords(itemOf(item)))
  else renderer.result(item)
}
