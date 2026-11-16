import type { Command } from "commander"
import * as v from "valibot"
import type { OwnerOnlySettings } from "../cli/config-command.js"
import type { Configuration, Settings } from "../cli/settings.js"
import type { AppIdentity } from "../ports/app.js"
import type { SignInSteps } from "../terminal/sign-in-steps.js"
import {
  type Asset,
  BLOCK_ROLES,
  BLOCK_TYPES,
  type Block,
  BUILT_IN_ACTIONS,
  type Condition,
  DISPLAY_CLASSES,
  INPUT_KINDS,
  type InputBlock,
  SETUP_FORMAT,
  SETUP_LIMITS,
  SETUP_VERSION,
  type SetupDocument,
  type Step,
  setupDocumentSchema,
  type Texts,
  type Value,
} from "./document.js"

export interface SetupCheckInput {
  command: Command
  profile: string
  /** The profile's settings with the answers' settings laid over `configured`: what the file would hold. */
  settings: Settings
  /** The secrets the path's inputs gave, by name. None is kept yet. */
  secrets: Readonly<Record<string, string>>
  answers: Readonly<Record<string, Value>>
  /** The sign-in events (`progress`, `needs`…) Desktop reads on stderr. */
  steps: SignInSteps
}

/** The CLI's own proof that the answers work, as its `session start` checks. A throw saves nothing. */
export type SetupCheck = (input: SetupCheckInput) => Promise<Record<string, unknown> | undefined>

export interface SetupDefinition {
  app: AppIdentity
  configuration: Pick<Configuration, "allSettings" | "settingSchema" | "resolveSettings" | "changeSetting">
  requires?: string[]
  start: string
  steps: Record<string, Step>
  assets?: Record<string, Asset>
  texts: { en: Texts } & Record<string, Texts>
  check?: SetupCheck
  /** The same list `configCommand` takes: settings an agent's run may not change, so a flow cannot either. */
  ownerOnly?: OwnerOnlySettings
}

export interface Setup {
  readonly app: AppIdentity
  readonly document: SetupDocument
  readonly definition: SetupDefinition
}

const KNOWN_FEATURES = new Set<string>([
  "run",
  ...BLOCK_TYPES.map((type) => `block.${type}`),
  ...INPUT_KINDS.map((kind) => `input.${kind}`),
  ...DISPLAY_CLASSES.map((name) => `class.${name}`),
])
const CLASSES = new Set<string>(DISPLAY_CLASSES)
const TYPES = new Set<string>(BLOCK_TYPES)
const ACTIONS = new Set<string>(BUILT_IN_ACTIONS)
// The file's permission table is the owner's, set with `config set`; a flow never writes it.
const NEVER_BOUND = new Set(["permissions"])

export interface ProblemOptions {
  /** The settings the CLI declares; left out, a bound setting is not checked. */
  settings?: readonly string[]
  /** Only what cli-core v1 builds: known types, roles and classes, run action `apply`, no `options_from`. */
  v1?: boolean
}

const conditionDepth = (condition: Condition): number => {
  const inner =
    "all" in condition ? condition.all : "any" in condition ? condition.any : "not" in condition ? [condition.not] : []
  return 1 + inner.reduce((deepest, one) => Math.max(deepest, conditionDepth(one)), 0)
}

const conditionsIn = (condition: Condition): Condition[] =>
  "all" in condition
    ? condition.all.flatMap(conditionsIn)
    : "any" in condition
      ? condition.any.flatMap(conditionsIn)
      : "not" in condition
        ? conditionsIn(condition.not)
        : [condition]

/** Every block of a step, groups opened, with how deep each sits. */
export const blocksOf = (blocks: readonly Block[] = [], depth = 1): { block: Block; depth: number }[] =>
  blocks.flatMap((block) => [{ block, depth }, ...(block.type === "group" ? blocksOf(block.blocks, depth + 1) : [])])

export const targetsOf = (step: Step): string[] =>
  step.next === undefined ? [] : typeof step.next === "string" ? [step.next] : step.next.map(({ to }) => to)

const textIdsOf = (block: Block): (string | undefined)[] => {
  const own = [block.fallback]
  switch (block.type) {
    case "text":
    case "heading":
    case "note":
      return [...own, block.text]
    case "image":
      return [...own, block.alt, block.caption]
    case "input":
    case "choice":
      return [
        ...own,
        block.label,
        block.hint,
        "placeholder" in block ? block.placeholder : undefined,
        ...(block.options ?? []).flatMap((option) => [option.label, option.hint]),
      ]
    case "group":
      return [...own, block.title]
    case "link":
      return [...own, block.text]
    case "requirement":
      return [...own, block.text, block.fix]
    default:
      return own
  }
}

/**
 * What is wrong with a setup document, each as one line: the schema first, then what a schema cannot say — every step
 * reachable, every target there, each text in English, each input bound once, the limits.
 */
export const setupProblems = (document: unknown, { settings, v1 = false }: ProblemOptions = {}): string[] => {
  const parsed = v.safeParse(setupDocumentSchema, document)
  if (!parsed.success) return parsed.issues.map((issue) => `${v.getDotPath(issue) ?? "document"}: ${issue.message}`)
  const doc = parsed.output
  const problems: string[] = []
  const add = (where: string, what: string) => problems.push(`${where}: ${what}`)

  const bytes = Buffer.byteLength(JSON.stringify(doc))
  if (bytes > SETUP_LIMITS.bytes) add("document", `is ${bytes} bytes, over ${SETUP_LIMITS.bytes}`)
  const steps = Object.entries(doc.steps)
  if (!doc.steps[doc.start]) add("start", `names no step: ${doc.start}`)

  const inputs = new Map<string, InputBlock | Extract<Block, { type: "choice" }>>()
  const results = new Set<string>()
  for (const [id, step] of steps) if (step.kind === "run") results.add(step.result ?? id)
  const conditions: [string, Condition][] = []
  const texts = new Set<string>()
  const en = new Set(Object.keys(doc.texts.en))

  for (const [id, step] of steps) {
    const at = `steps.${id}`
    texts.add(step.title)
    const kind = step.kind ?? "form"
    for (const target of targetsOf(step)) if (!doc.steps[target]) add(`${at}.next`, `names no step: ${target}`)
    if (Array.isArray(step.next)) {
      step.next.forEach((edge, index) => {
        if (edge.when) conditions.push([`${at}.next.${index}.when`, edge.when])
      })
      if (step.next.at(-1)?.when) add(`${at}.next`, "the last edge has a condition, so the flow can stop on none")
    }
    if (kind === "done" && step.next !== undefined) add(at, "a done step ends the flow and has no next")
    if (kind !== "done" && step.next === undefined) add(at, "has no next; only a done step ends the flow")
    if (kind === "run" && !step.action) add(at, "a run step names its action")
    if (kind !== "run" && (step.action || step.asks)) add(at, "action and asks belong to a run step")
    if (v1 && step.action && !ACTIONS.has(step.action))
      add(`${at}.action`, `${step.action} is not built in; v1 runs only ${BUILT_IN_ACTIONS.join(", ")}`)
    for (const ask of Object.values(step.asks ?? {})) texts.add(ask.label)

    for (const { block, depth } of blocksOf(step.blocks)) {
      const where = `${at}.blocks${block.id ? ` (${block.id})` : ` (${block.type})`}`
      if (depth > SETUP_LIMITS.depth) add(where, `groups nest deeper than ${SETUP_LIMITS.depth}`)
      if (block.when) conditions.push([where, block.when])
      for (const text of textIdsOf(block)) if (text) texts.add(text)
      if (!TYPES.has(block.type)) {
        if (v1) add(where, `${block.type} is no block type of v1`)
        continue
      }
      if (v1 && block.role !== undefined && !BLOCK_ROLES[block.type]?.includes(block.role))
        add(
          where,
          `role ${block.role} is not one of ${block.type}'s: ${(BLOCK_ROLES[block.type] ?? []).join(", ") || "none"}`,
        )
      if (v1) for (const name of block.class ?? []) if (!CLASSES.has(name)) add(where, `class ${name} is not reserved`)
      if (block.type === "image" && !doc.assets?.[block.asset]) add(where, `asset ${block.asset} is not in assets`)
      if (block.type !== "input" && block.type !== "choice") continue
      if (inputs.has(block.id)) add(where, `input id ${block.id} is used twice`)
      inputs.set(block.id, block)
      if (kind === "done") add(where, "a done step has no inputs")
      const secret = block.type === "input" ? block.secret : undefined
      if (block.type === "input" && (block.setting === undefined) === (secret === undefined))
        add(where, "an input binds exactly one of setting or secret")
      if (secret !== undefined && !/^[a-z]/.test(secret))
        add(where, `secret ${secret} is kept, so it starts with a letter`)
      if (block.type === "input" && block.input === "password" && secret === undefined)
        add(where, "a password input binds a secret")
      if (block.type === "input" && ["select", "multiselect"].includes(block.input) && !block.options?.length)
        add(where, `a ${block.input} input lists its options`)
      if (v1 && block.type === "input" && block.options_from) add(where, "options_from is reserved, not in v1")
      if (block.setting !== undefined) {
        if (NEVER_BOUND.has(block.setting)) add(where, `${block.setting} is the owner's to set, never a flow's`)
        else if (settings && !settings.includes(block.setting))
          add(where, `setting ${block.setting} is not in the CLI's configuration`)
      }
    }
  }

  for (const [where, condition] of conditions) {
    if (conditionDepth(condition) > SETUP_LIMITS.depth) add(where, `conditions nest deeper than ${SETUP_LIMITS.depth}`)
    for (const one of conditionsIn(condition)) {
      if ("field" in one && !inputs.has(one.field)) add(where, `field ${one.field} is no input's id`)
      if ("result" in one && !results.has(one.result)) add(where, `result ${one.result} is no run step's`)
    }
  }

  const reached = new Set<string>()
  const queue = doc.steps[doc.start] ? [doc.start] : []
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (reached.has(at)) continue
    reached.add(at)
    const step = doc.steps[at]
    for (const target of step ? targetsOf(step) : []) if (doc.steps[target]) queue.push(target)
  }
  for (const [id] of steps) if (!reached.has(id)) add(`steps.${id}`, `cannot be reached from ${doc.start}`)

  for (const text of texts) if (!en.has(text)) add("texts.en", `has no ${text}`)
  for (const [language, entries] of Object.entries(doc.texts))
    for (const text of Object.keys(entries)) if (!en.has(text)) add(`texts.${language}`, `${text} is not in en`)
  if (v1)
    for (const feature of doc.requires ?? []) if (!KNOWN_FEATURES.has(feature)) add("requires", `${feature} is unknown`)
  return problems
}

/**
 * A CLI's connection flow, built and checked once: a wrong flow throws here, so the CLI's own tests fail before it
 * ships. Asset files are checked by `setupFileProblems`, from those tests, never at start.
 */
export const defineSetup = (definition: SetupDefinition): Setup => {
  const { app, requires, start, steps, assets, texts } = definition
  const document: SetupDocument = {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    tool: app.command,
    toolVersion: app.version,
    ...(requires ? { requires } : {}),
    start,
    steps,
    ...(assets ? { assets } : {}),
    texts,
  }
  const problems = setupProblems(document, { settings: definition.configuration.allSettings, v1: true })
  if (problems.length > 0) throw new Error(`${app.command}'s setup flow is wrong:\n${problems.join("\n")}`)
  return { app, document, definition }
}
