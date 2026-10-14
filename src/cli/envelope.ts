import { exitCodeOfAnswer, type Renderer, type RenderFormat, type Streams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import {
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
} from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import * as v from "valibot"
import { currentRun } from "./runs/scope.js"
import { nextStep, rootOf, runnable, stepLine, withSafety } from "./steps.js"

export type ListBody<T> = Omit<ListEnvelope<T>, "meta"> & { meta?: Partial<Meta> }
export type ItemBody<T> = Omit<ItemEnvelope<T>, "meta"> & { meta?: Partial<Meta> }
export type Body<T = unknown> = ListBody<T> | ItemBody<T>

/** Only bodies built here get `meta`: an answer still in its old shape passes through untouched. */
const built = new WeakSet<object>()

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
  const { items, limit, has_more, cursor, paging, page, args = {}, next = [], missing, meta } = input
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
      ? { mode: "cursor", limit, has_more, ...(has_more && cursor !== undefined ? { next_cursor: cursor } : {}) }
      : { mode: "page", limit, has_more, ...(has_more ? { next_page: (page ?? 1) + 1 } : {}) },
    ...capped([...more, ...next]),
    ...(missing && missing.length > 0 ? { missing } : {}),
    ...(meta ? { meta } : {}),
  }
  built.add(body)
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
  built.add(body)
  return body
}

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/**
 * An answer that has no entity yet — a write's receipt, a count — with snake_case keys, nested ones too.
 * Only for records whose keys are field names, never for one keyed by data.
 */
export const snakeKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(snakeKeys)
  if (value === null || typeof value !== "object" || value.constructor !== Object) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inner]) => (inner === undefined ? [] : [[snake(key), snakeKeys(inner)]])),
  )
}

export const isBody = (value: unknown): value is Body => typeof value === "object" && value !== null && built.has(value)

/** The answer with each next step judged by `targets` — for MCP, which prints no command line to check them by. */
export const judgedAnswer = <T>(value: T, targets: NonNullable<StepInput["targets"]>): T => {
  if (!isBody(value) || !value.next) return value
  const judged = { ...value, next: withSafety(value.next, targets) }
  built.add(judged)
  return judged as T
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

/** The one place an answer gets its `meta`, for the CLI and MCP alike. Anything else is returned as it was. */
export const sealed = <T>(value: T): T => {
  if (!isBody(value)) return value
  const { meta, ...rest } = value
  return { ...rest, meta: metaNow(meta) } as T
}

export interface AnswerOutput {
  renderer: Renderer
  format: RenderFormat
  streams: Streams
}

/** An answer as JSON lines: one line per item, then the end line. One thing is a list of one that has no more. */
const linesOf = <T>(body: ListEnvelope<T> | ItemEnvelope<T>): string =>
  jsonlOf(
    "items" in body ? body : { items: [body.item], page: { mode: "page", limit: 1, has_more: false }, meta: body.meta },
  )

/**
 * Prints an answer. Machine output gets the whole envelope (`--jsonl` the items and an end line); a person gets
 * the items — `view` draws them — and each next step this CLI has, as a line on stderr. A partial answer the
 * command does not declare `partial` exits with its first issue's code, after printing what was read.
 */
export const renderAnswer = <T>(
  command: Command,
  { renderer, format, streams }: AnswerOutput,
  body: Body<T>,
  view?: (body: Body<T>) => string,
): void => {
  const root = rootOf(command)
  const next = runnable(root, body.next)
  const kept = { ...body, ...(next.length > 0 ? { next } : {}) } as Body<T>
  if (next.length === 0) delete (kept as { next?: unknown }).next
  built.add(kept)
  const whole = sealed(kept) as ListEnvelope<T> | ItemEnvelope<T>
  if (format === "json") renderer.result(whole)
  else if (format === "jsonl") for (const line of linesOf(whole).split("\n")) streams.data(line)
  else if (view) streams.data(view(kept))
  else renderer.result("items" in kept ? kept.items : kept.item)
  const code = exitCodeOfAnswer(whole.meta, metaOf(command).partial === true)
  if (code !== 0) process.exitCode = code
  if (format === "json") return
  for (const step of next)
    renderer.note(step.kind === "command" ? `→ ${step.why}: ${stepLine(root, step)}` : `→ ${step.why}`)
}
