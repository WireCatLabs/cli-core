import * as v from "valibot"
import type { Setup } from "./define.js"
import {
  type Block,
  type ChoiceBlock,
  type Condition,
  type InputBlock,
  SETUP_LIMITS,
  type Step,
  type Value,
} from "./document.js"

export type Field = InputBlock | ChoiceBlock

/** A run's outcome on the path, as `result` conditions read it. */
export type Outcome = { outcome: "ok" } | { outcome: "error"; code: string }

/** The current settings (by setting name) and which secrets are kept (by secret name), when a profile is edited. */
export type Current = Readonly<Record<string, Value | { set: true }>>

export interface Known {
  field: (id: string) => unknown
  result: (name: string) => Outcome | undefined
}

export const holds = (condition: Condition, known: Known): boolean => {
  if ("all" in condition) return condition.all.every((one) => holds(one, known))
  if ("any" in condition) return condition.any.some((one) => holds(one, known))
  if ("not" in condition) return !holds(condition.not, known)
  if ("result" in condition) {
    const outcome = known.result(condition.result)
    if (!outcome) return false
    return "is" in condition
      ? outcome.outcome === "ok"
      : outcome.outcome === "error" && outcome.code === condition.error
  }
  const value = known.field(condition.field)
  if ("set" in condition) return (value !== undefined) === condition.set
  if (value === undefined) return false
  if ("in" in condition) return (condition.in as unknown[]).includes(value)
  return value === condition.is
}

/** The inputs shown now: a block whose `when` fails hides itself and, for a group, everything in it. */
export const visibleFields = (blocks: readonly Block[] = [], known: Known): Field[] =>
  blocks.flatMap((block) => {
    if (block.when && !holds(block.when, known)) return []
    if (block.type === "group") return visibleFields(block.blocks, known)
    return block.type === "input" || block.type === "choice" ? [block] : []
  })

export const nextOf = (step: Step, known: Known): string | undefined => {
  if (typeof step.next === "string") return step.next
  return step.next?.find((edge) => !edge.when || holds(edge.when, known))?.to
}

const blank = (value: unknown) => value === undefined || value === null || value === ""

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((one) => typeof one === "string")

/** The kind's own shape; a setting's schema then has the final word. */
const shapeProblem = (field: Field, value: unknown): string | undefined => {
  const choices = field.options?.map((option) => option.value)
  const kind = field.type === "choice" ? "select" : field.input
  const counted = (list: string[]) => {
    if (field.type === "input" && field.min !== undefined && list.length < field.min)
      return `needs at least ${field.min}`
    if (field.type === "input" && field.max !== undefined && list.length > field.max)
      return `takes at most ${field.max}`
    return undefined
  }
  switch (kind) {
    case "select":
      return typeof value === "string" && (!choices || choices.includes(value))
        ? undefined
        : `has to be one of: ${choices?.join(", ")}`
    case "multiselect":
      if (!strings(value) || (choices && value.some((one) => !choices.includes(one))))
        return `has to be a list of: ${choices?.join(", ")}`
      return counted(value)
    case "countries":
      if (!strings(value) || value.some((one) => !/^[A-Za-z]{2}$/.test(one)))
        return "has to be a list of two-letter country codes"
      return counted(value)
    case "toggle":
      return typeof value === "boolean" ? undefined : "has to be true or false"
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "has to be a number"
    case "port":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
        ? undefined
        : "has to be a port number, 1 to 65535"
    default:
      return typeof value === "string" ? undefined : "has to be text"
  }
}

export interface FieldCheck {
  value?: Value
  problem?: string
}

/** One answer against its input and its setting's own schema; an empty answer takes the current value or the default. */
export const checkField = (
  field: Field,
  raw: unknown,
  { current = {}, settingSchema }: { current?: Current; settingSchema: (key: string) => v.GenericSchema | undefined },
): FieldCheck => {
  const bound = field.setting ?? (field.type === "input" ? field.secret : undefined)
  if (blank(raw)) {
    if (field.default !== undefined && (bound === undefined || current[bound] === undefined))
      return { value: field.default }
    // A toggle left alone is an answer of its own: the setting keeps its default.
    const toggle = field.type === "input" && field.input === "toggle"
    if (field.optional || toggle || (bound !== undefined && current[bound] !== undefined)) return {}
    return { problem: "is needed" }
  }
  const shape = shapeProblem(field, raw)
  if (shape) return { problem: shape }
  const schema = field.setting === undefined ? undefined : settingSchema(field.setting)
  if (schema) {
    const parsed = v.safeParse(schema, raw)
    if (!parsed.success) return { problem: parsed.issues[0]?.message ?? "is not valid" }
  }
  return { value: raw as Value }
}

export interface InputProblem {
  input: string
  setting: string | null
  message: string
}

export interface PathAnswers {
  /** The steps visited, in order. */
  path: string[]
  /** Where the walk stopped: a run step, a done step, or the first step with a problem. */
  at: string
  stopped: "run" | "done" | "problem" | "stuck"
  kept: Record<string, Value>
  /** Answers on steps not visited, or inputs hidden on them: never checked, never saved. */
  dropped: string[]
  errors: InputProblem[]
  settings: Record<string, Value>
  secrets: Record<string, string>
}

/**
 * The owner's answers along the path they lead to, from `start` to the first run or done step. Only inputs shown on a
 * visited step count; everything else is dropped, so an answer on a branch the owner left is never saved.
 */
export const walk = (
  setup: Setup,
  answers: Readonly<Record<string, unknown>>,
  { current = {}, results = {} }: { current?: Current; results?: Readonly<Record<string, Outcome>> } = {},
): PathAnswers => {
  const { document, definition } = setup
  const settingSchema = definition.configuration.settingSchema
  const fields = new Map<string, Field>()
  const kept: Record<string, Value> = {}
  const known: Known = {
    field: (id) => {
      if (Object.hasOwn(kept, id)) return kept[id]
      const field = fields.get(id)
      if (!field) return undefined
      if (!blank(answers[id])) return answers[id]
      return field.setting === undefined ? undefined : current[field.setting]
    },
    result: (name) => results[name],
  }
  const result: PathAnswers = {
    path: [],
    at: document.start,
    stopped: "stuck",
    kept,
    dropped: [],
    errors: [],
    settings: {},
    secrets: {},
  }
  const bound = new Map<string, string>()
  let at: string | undefined = document.start
  for (let moves = 0; at !== undefined && moves < SETUP_LIMITS.transitions; moves++) {
    const step: Step | undefined = document.steps[at]
    if (!step) break
    result.path.push(at)
    result.at = at
    if (step.kind === "run" || step.kind === "done") {
      result.stopped = step.kind
      break
    }
    // A field's answer can show another field of the same step: read until what is shown stops changing.
    const before = result.errors.length
    let shown: Field[] = []
    for (let round = 0; round < 5; round++) {
      const now = visibleFields(step.blocks, known)
      for (const field of now) fields.set(field.id, field)
      if (now.length === shown.length && now.every((field, index) => field === shown[index])) break
      shown = now
    }
    for (const field of shown) {
      const checked = checkField(field, answers[field.id], { current, settingSchema })
      const name = field.setting ?? (field.type === "input" ? field.secret : undefined)
      if (checked.problem) {
        result.errors.push({ input: field.id, setting: field.setting ?? null, message: checked.problem })
        continue
      }
      if (name !== undefined && bound.has(name) && bound.get(name) !== field.id) {
        result.errors.push({
          input: field.id,
          setting: field.setting ?? null,
          message: `${name} is already answered by ${bound.get(name)} on this path`,
        })
        continue
      }
      if (checked.value === undefined) continue
      kept[field.id] = checked.value
      if (name !== undefined) bound.set(name, field.id)
    }
    if (result.errors.length > before) {
      result.stopped = "problem"
      break
    }
    at = nextOf(step, known)
  }
  for (const field of fields.values()) {
    const value = kept[field.id]
    if (value === undefined) continue
    if (field.setting !== undefined) result.settings[field.setting] = value
    else if (field.type === "input" && field.secret !== undefined && typeof value === "string")
      result.secrets[field.secret] = value
  }
  result.dropped = Object.keys(answers).filter((id) => !Object.hasOwn(kept, id))
  return result
}
