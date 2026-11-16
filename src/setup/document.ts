import { toJsonSchema } from "@valibot/to-json-schema"
import * as v from "valibot"

/**
 * The WireCat setup format, version 1: a CLI's connection flow as data, which WireCat Desktop draws, the terminal asks
 * and the docs render. Desktop treats the document as untrusted input, so this schema is the contract it copies
 * (`test/fixtures/setup-v1/`). Unknown keys pass everywhere but in conditions: a newer CLI may add an optional key,
 * and an older renderer ignores it.
 */

export const SETUP_FORMAT = "wirecat.setup"
export const SETUP_VERSION = 1

export const SETUP_LIMITS = {
  bytes: 256 * 1024,
  steps: 60,
  /** Groups inside groups, and conditions inside conditions. */
  depth: 8,
  transitions: 100,
  imageBytes: 2 * 1024 * 1024,
} as const

// No lookahead anywhere: Desktop checks these patterns in Rust, whose regex has none.
export const SETUP_PATTERNS = {
  step: /^[a-z][a-z0-9-]{0,47}$/,
  input: /^[a-z][a-z0-9_-]{0,47}$/,
  text: /^[a-z][a-z0-9_.-]{0,95}$/,
  action: /^[a-z][a-z0-9-]{0,31}$/,
  setting: /^[a-z][a-z0-9_]{0,63}$/,
  /** `2fa` is asked mid-run and never kept; a kept secret starts with a letter, as the keyring entry wants. */
  secret: /^[a-z0-9][a-z0-9-]{0,31}$/,
  feature: /^[a-z][a-z0-9_./-]{0,63}$/,
  name: /^[a-z][a-z0-9/-]{0,31}$/,
  param: /^[a-z][a-z0-9_]{0,31}$/,
  language: /^[a-z]{2}(-[A-Z]{2})?$/,
  /** Relative to the package root; no segment starts with a dot, so `..` cannot climb out. */
  file: /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.(png|jpe?g|webp)$/,
  href: /^https:\/\/[^\s"<>]{1,2000}$/,
} as const

export const BLOCK_TYPES = [
  "text",
  "heading",
  "note",
  "image",
  "code",
  "input",
  "choice",
  "group",
  "link",
  "requirement",
  "divider",
] as const
export type BlockType = (typeof BLOCK_TYPES)[number]

export const INPUT_KINDS = [
  "text",
  "number",
  "port",
  "toggle",
  "password",
  "file",
  "folder",
  "select",
  "multiselect",
  "countries",
  "timezone",
] as const
export type InputKind = (typeof INPUT_KINDS)[number]

export const STEP_KINDS = ["form", "run", "done"] as const

/** What a block is; how it is laid out is `class`. A role a renderer does not know is drawn as the default. */
export const BLOCK_ROLES: Partial<Record<BlockType, readonly string[]>> = {
  note: ["tip", "info", "warning", "danger", "success"],
  group: ["card", "details", "row"],
  link: ["button", "inline"],
}

/** The reserved display classes. Desktop maps each to its own design tokens; any other name is ignored. */
export const DISPLAY_CLASSES = [
  ...["w-auto", "w-1/3", "w-1/2", "w-2/3", "w-full", "w-narrow"],
  ...["h-sm", "h-md", "h-lg", "h-xl"],
  ...["grow-1", "grow-2", "grow-3", "grow-4"],
  ...["mt-none", "mt-sm", "mt-md", "mt-lg", "mb-none", "mb-sm", "mb-md", "mb-lg", "gap-sm", "gap-md", "gap-lg"],
  ...["start", "center", "end"],
  ...["text-sm", "text-lg", "muted", "strong", "mono"],
  ...["raised", "outlined", "accent"],
  ...["first", "last"],
  ...["hide-narrow", "hide-wide"],
  ...["cols-2", "cols-3"],
] as const

/** The run actions cli-core runs itself. A tool's own (`oauth`, `qr`) are reserved in the format, not built in v1. */
export const BUILT_IN_ACTIONS = ["apply"] as const

export type Condition =
  | { field: string; is: string | number | boolean }
  | { field: string; in: (string | number)[] }
  | { field: string; set: boolean }
  | { result: string; is: "ok" }
  | { result: string; error: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }

export type Value = string | number | boolean | string[]

interface BlockBase {
  id?: string
  when?: Condition
  role?: string
  class?: string[]
  /** A text an older renderer shows in place of a block type it does not know. */
  fallback?: string
}

export interface Option {
  value: string
  label: string
  hint?: string
  icon?: string
}

export interface TextBlock extends BlockBase {
  type: "text"
  text: string
  params?: Record<string, string>
}
export interface HeadingBlock extends BlockBase {
  type: "heading"
  text: string
  level?: 2 | 3
  params?: Record<string, string>
}
export interface NoteBlock extends BlockBase {
  type: "note"
  text: string
  params?: Record<string, string>
}
export interface ImageBlock extends BlockBase {
  type: "image"
  asset: string
  alt: string
  caption?: string
}
export interface CodeBlock extends BlockBase {
  type: "code"
  code: string
  copy?: boolean
  language?: string
}
export interface InputBlock extends BlockBase {
  type: "input"
  id: string
  setting?: string
  secret?: string
  input: InputKind
  label: string
  hint?: string
  placeholder?: string
  optional?: boolean
  default?: Value
  multiline?: boolean
  min?: number
  max?: number
  accept?: string[]
  options?: Option[]
  /** Reserved: a run action whose result lists the options. Not in v1. */
  options_from?: string
  /** The setting's JSON Schema; `setup show` adds it, an author never writes it. */
  schema?: Record<string, unknown>
}
export interface ChoiceBlock extends BlockBase {
  type: "choice"
  id: string
  setting?: string
  label?: string
  hint?: string
  options: Option[]
  optional?: boolean
  default?: string
  schema?: Record<string, unknown>
}
export interface GroupBlock extends BlockBase {
  type: "group"
  blocks: Block[]
  title?: string
}
export interface LinkBlock extends BlockBase {
  type: "link"
  href: string
  text: string
}
export interface RequirementBlock extends BlockBase {
  type: "requirement"
  check: string
  text: string
  fix?: string
}
export interface DividerBlock extends BlockBase {
  type: "divider"
}

export type Block =
  | TextBlock
  | HeadingBlock
  | NoteBlock
  | ImageBlock
  | CodeBlock
  | InputBlock
  | ChoiceBlock
  | GroupBlock
  | LinkBlock
  | RequirementBlock
  | DividerBlock

export interface Edge {
  when?: Condition
  to: string
}

export interface Step {
  title: string
  kind?: (typeof STEP_KINDS)[number]
  blocks?: Block[]
  next?: string | Edge[]
  back?: boolean
  /** A run step's action: `apply` in v1. */
  action?: string
  /** A run's `needs` event kind → the input shown for it mid-run. */
  asks?: Record<string, InputBlock>
  /** The name `result` conditions read this run's outcome under; the step id when left out. */
  result?: string
}

export interface Asset {
  file: string
  width?: number
  height?: number
}

export type Texts = Record<string, string>

export interface SetupDocument {
  format: typeof SETUP_FORMAT
  version: typeof SETUP_VERSION
  tool: string
  toolVersion?: string
  requires?: string[]
  start: string
  steps: Record<string, Step>
  assets?: Record<string, Asset>
  texts: { en: Texts } & Record<string, Texts>
  /** Only with a profile: its current settings; a secret is `{ set: true }`, never its value. */
  values?: Record<string, Value | { set: true }>
}

const pattern = (regex: RegExp, what: string) => v.pipe(v.string(), v.regex(regex, `has to be ${what}`))
const textId = pattern(SETUP_PATTERNS.text, "a text id")
const stepId = pattern(SETUP_PATTERNS.step, "a step id")
const inputId = pattern(SETUP_PATTERNS.input, "an input id")
const action = pattern(SETUP_PATTERNS.action, "an action name")
const name = pattern(SETUP_PATTERNS.name, "a name")
const params = v.optional(
  v.record(pattern(SETUP_PATTERNS.param, "a parameter name"), v.pipe(v.string(), v.maxLength(200))),
)
const value = v.union([v.string(), v.number(), v.boolean(), v.array(v.string())])

const CONDITION: v.GenericSchema<Condition> = v.union([
  v.strictObject({ field: inputId, is: v.union([v.string(), v.number(), v.boolean()]) }),
  v.strictObject({ field: inputId, in: v.array(v.union([v.string(), v.number()])) }),
  v.strictObject({ field: inputId, set: v.boolean() }),
  v.strictObject({ result: stepId, is: v.literal("ok") }),
  v.strictObject({ result: stepId, error: pattern(/^[a-z][a-z0-9_]{0,63}$/, "an error code") }),
  v.strictObject({ all: v.array(v.lazy(() => CONDITION)) }),
  v.strictObject({ any: v.array(v.lazy(() => CONDITION)) }),
  v.strictObject({ not: v.lazy(() => CONDITION) }),
])

const base = {
  id: v.optional(inputId),
  when: v.optional(v.lazy(() => CONDITION)),
  role: v.optional(name),
  class: v.optional(v.array(name)),
  fallback: v.optional(textId),
}

const OPTION = v.looseObject({ value: v.string(), label: textId, hint: v.optional(textId), icon: v.optional(name) })

const INPUT = v.looseObject({
  ...base,
  type: v.literal("input"),
  id: inputId,
  setting: v.optional(pattern(SETUP_PATTERNS.setting, "a setting name")),
  secret: v.optional(pattern(SETUP_PATTERNS.secret, "a secret name")),
  input: v.picklist(INPUT_KINDS),
  label: textId,
  hint: v.optional(textId),
  placeholder: v.optional(textId),
  optional: v.optional(v.boolean()),
  default: v.optional(value),
  multiline: v.optional(v.boolean()),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  accept: v.optional(v.array(pattern(/^\.[a-z0-9]{1,10}$/, "an extension such as .csv"))),
  options: v.optional(v.array(OPTION)),
  options_from: v.optional(action),
  schema: v.optional(v.record(v.string(), v.unknown())),
})

const KNOWN_BLOCK = v.variant("type", [
  v.looseObject({ ...base, type: v.literal("text"), text: textId, params }),
  v.looseObject({ ...base, type: v.literal("heading"), text: textId, level: v.optional(v.picklist([2, 3])), params }),
  v.looseObject({ ...base, type: v.literal("note"), text: textId, params }),
  v.looseObject({ ...base, type: v.literal("image"), asset: stepId, alt: textId, caption: v.optional(textId) }),
  v.looseObject({
    ...base,
    type: v.literal("code"),
    code: v.pipe(v.string(), v.maxLength(4000)),
    copy: v.optional(v.boolean()),
    language: v.optional(name),
  }),
  INPUT,
  v.looseObject({
    ...base,
    type: v.literal("choice"),
    id: inputId,
    setting: v.optional(pattern(SETUP_PATTERNS.setting, "a setting name")),
    label: v.optional(textId),
    hint: v.optional(textId),
    options: v.pipe(v.array(OPTION), v.minLength(1)),
    optional: v.optional(v.boolean()),
    default: v.optional(v.string()),
    schema: v.optional(v.record(v.string(), v.unknown())),
  }),
  v.looseObject({
    ...base,
    type: v.literal("group"),
    blocks: v.array(v.lazy(() => BLOCK)),
    title: v.optional(textId),
  }),
  v.looseObject({
    ...base,
    type: v.literal("link"),
    href: pattern(SETUP_PATTERNS.href, "an https link"),
    text: textId,
  }),
  v.looseObject({ ...base, type: v.literal("requirement"), check: action, text: textId, fix: v.optional(textId) }),
  v.looseObject({ ...base, type: v.literal("divider") }),
])

const NOT_KNOWN = v.check(
  (type: string) => !(BLOCK_TYPES as readonly string[]).includes(type),
  "is a known block type, written wrongly",
)
const UNKNOWN_TYPE = v.pipe(name, NOT_KNOWN)

/** A block type from a newer format: kept, so an older renderer shows its `fallback` and goes on. */
const UNKNOWN_BLOCK = v.looseObject({ ...base, type: UNKNOWN_TYPE })

const BLOCK: v.GenericSchema<Block> = v.union([KNOWN_BLOCK, UNKNOWN_BLOCK]) as unknown as v.GenericSchema<Block>

const EDGE = v.looseObject({ when: v.optional(CONDITION), to: stepId })

const STEP = v.looseObject({
  title: textId,
  kind: v.optional(v.picklist(STEP_KINDS)),
  blocks: v.optional(v.array(BLOCK)),
  next: v.optional(v.union([stepId, v.array(EDGE)])),
  back: v.optional(v.boolean()),
  action: v.optional(action),
  asks: v.optional(v.record(name, INPUT)),
  result: v.optional(stepId),
})

const TEXTS = v.record(textId, v.pipe(v.string(), v.maxLength(4000)))

export const setupDocumentSchema = v.looseObject({
  format: v.literal(SETUP_FORMAT),
  version: v.literal(SETUP_VERSION),
  tool: pattern(/^[a-z][a-z0-9-]{0,31}$/, "the CLI's command"),
  toolVersion: v.optional(pattern(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "a version")),
  requires: v.optional(v.array(pattern(SETUP_PATTERNS.feature, "a feature name"))),
  start: stepId,
  steps: v.pipe(v.record(stepId, STEP), v.maxEntries(SETUP_LIMITS.steps)),
  assets: v.optional(
    v.record(
      stepId,
      v.looseObject({
        file: pattern(SETUP_PATTERNS.file, "a PNG, JPEG or WebP file inside the package"),
        width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
    ),
  ),
  texts: v.objectWithRest({ en: TEXTS }, TEXTS),
  values: v.optional(v.record(v.string(), v.union([value, v.strictObject({ set: v.literal(true) })]))),
}) as unknown as v.GenericSchema<SetupDocument>

/** The document's JSON Schema (draft-07), the one Desktop checks a description against. */
export const setupJsonSchema = (): Record<string, unknown> => {
  const schema = toJsonSchema(setupDocumentSchema, {
    errorMode: "ignore",
    definitions: { block: BLOCK, condition: CONDITION },
    // `v.check` has no JSON Schema form; without this an unknown-type branch would take a broken known block.
    overrideAction: ({ valibotAction, jsonSchema }) =>
      valibotAction === NOT_KNOWN ? { ...jsonSchema, not: { enum: [...BLOCK_TYPES] } } : undefined,
  })
  return {
    title: "WireCat setup document, version 1",
    ...schema,
  }
}
