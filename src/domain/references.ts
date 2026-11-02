import { CliError, singleLine } from "@wirecat/cli-base"
import { formatMeetingReference, type MeetingReference, parseMeetingReference } from "../meetings/index.js"
import { formatLocator, parseLocator } from "./locator.js"

/**
 * One typed form for every kind of thing a link, a tag or an argument can name. The prefix makes a
 * wrong kind fail loudly instead of matching another row. Parts that are ids of someone else's system
 * are percent-encoded, as in a message locator, so no id can add a part.
 */
export type Reference =
  | { type: "message"; provider: string; account: string; chat: string; message: string }
  | { type: "chat"; provider: string; account: string; chat: string }
  | { type: "contact"; provider: string; id: string }
  | { type: SimpleReference; id: string }
  /** A notes folder, or one subfolder of it: `path` is inside the folder, `null` the folder itself. */
  | { type: "folder"; id: string; path: string | null }
  | MeetingReference

/**
 * Things named by their store id (a task also by its key or the task package's id). `entity` is the name
 * before organizations and projects: it still parses, so an old file's reference resolves as not found.
 */
export const SIMPLE_REFERENCES = [
  "note",
  "document",
  "person",
  "organization",
  "project",
  "task",
  "memory",
  "fact",
  "bot",
  "event",
  "entity",
] as const
export type SimpleReference = (typeof SIMPLE_REFERENCES)[number]

export type RefKindName = Exclude<Reference["type"], "entity">

export interface RefKindSpec<R extends Reference = Reference> {
  /** The word before the first colon: `chat`, `msg`, `document`. */
  prefix: string
  type: R["type"]
  /** For error texts: `chat:<provider>/<account>/<chat>`. */
  shape: string
  parse(rest: string, text: string): R
  format(reference: R): string
}

const malformed = (text: string, shape: string) =>
  new CliError("validation_error", `"${singleLine(text)}" is not a reference — expected ${shape}`, {
    reason: "ref.malformed",
  })

const parts = (rest: string, count: number, text: string, shape: string) => {
  const split = rest.split("/")
  if (split.length !== count || split.some((part) => part === "")) throw malformed(text, shape)
  return split.map(decodeURIComponent)
}

const encoded = (...values: string[]) => values.map(encodeURIComponent).join("/")

/** A subfolder spelled one way: no leading, trailing or doubled slash, and `.` for the folder itself. */
const folderPath = (path: string): string | null => {
  const clean = path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")
  return clean === "" ? (path.trim() === "" ? "" : null) : clean
}

const MEETING_SHAPE = "meeting:<account>/<meeting>[/<transcript>[/<cue>]] with safe integer ids"

const kind = <R extends Reference>(spec: RefKindSpec<R>) => spec as unknown as RefKindSpec

const simple = (prefix: SimpleReference) =>
  kind<{ type: SimpleReference; id: string }>({
    prefix,
    type: prefix,
    shape: `${prefix}:<id>`,
    parse: (rest, text) => {
      if (!rest.trim())
        throw new CliError("validation_error", `"${singleLine(text)}" names no ${prefix}`, {
          reason: "ref.malformed",
        })
      return { type: prefix, id: rest }
    },
    format: (reference) => `${reference.type}:${reference.id}`,
  })

/** Every kind of reference. A new kind is one row here; nothing else switches on the prefix. */
export const REF_KINDS: readonly RefKindSpec[] = [
  kind<Extract<Reference, { type: "message" }>>({
    prefix: "msg",
    type: "message",
    shape: "msg:<provider>/<account>/<chat>/<message>",
    parse: (_, text) => {
      try {
        return { type: "message", ...parseLocator(text) }
      } catch {
        throw malformed(text, "msg:<provider>/<account>/<chat>/<message>")
      }
    },
    format: formatLocator,
  }),
  kind<Extract<Reference, { type: "chat" }>>({
    prefix: "chat",
    type: "chat",
    shape: "chat:<provider>/<account>/<chat>",
    parse: (rest, text) => {
      const [provider, account, chat] = parts(rest, 3, text, "chat:<provider>/<account>/<chat>") as [
        string,
        string,
        string,
      ]
      return { type: "chat", provider, account, chat }
    },
    format: ({ provider, account, chat }) => `chat:${encoded(provider, account, chat)}`,
  }),
  kind<Extract<Reference, { type: "contact" }>>({
    prefix: "contact",
    type: "contact",
    shape: "contact:<provider>/<id>",
    parse: (rest, text) => {
      const [provider, id] = parts(rest, 2, text, "contact:<provider>/<id>") as [string, string]
      return { type: "contact", provider, id }
    },
    format: ({ provider, id }) => `contact:${encoded(provider, id)}`,
  }),
  kind<Extract<Reference, { type: "folder" }>>({
    prefix: "folder",
    type: "folder",
    shape: "folder:<id>[/<path>]",
    parse: (rest, text) => {
      const slash = rest.indexOf("/")
      const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash))
      const path = slash < 0 ? null : folderPath(decodeURIComponent(rest.slice(slash + 1)))
      if (!id.trim() || path === "") throw malformed(text, "folder:<id>[/<path>]")
      return { type: "folder", id, path }
    },
    format: ({ id, path }) => (path === null ? `folder:${encodeURIComponent(id)}` : `folder:${encoded(id, path)}`),
  }),
  kind<MeetingReference>({
    prefix: "meeting",
    type: "meeting",
    shape: MEETING_SHAPE,
    parse: (_, text) => {
      try {
        return parseMeetingReference(text)
      } catch {
        throw malformed(text, MEETING_SHAPE)
      }
    },
    format: formatMeetingReference,
  }),
  ...SIMPLE_REFERENCES.map(simple),
]

const byPrefix = new Map(REF_KINDS.map((spec) => [spec.prefix, spec]))
const byType = new Map(REF_KINDS.map((spec) => [spec.type as string, spec]))

/** The prefixes people are told about: `entity` only still parses. */
const offered = REF_KINDS.map(({ prefix }) => prefix).filter((prefix) => prefix !== "entity")

const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, at) => at)
  for (const [i, x] of [...a].entries()) {
    const next = [i + 1]
    for (const [j, y] of [...b].entries())
      next.push(Math.min((row[j + 1] as number) + 1, (next[j] as number) + 1, (row[j] as number) + (x === y ? 0 : 1)))
    row = next
  }
  return row[b.length] as number
}

/** `doc` reads as `document`, not as `bot` one letter away: a typed start of a prefix wins over spelling. */
const nearest = (typed: string): string | undefined =>
  offered.find((prefix) => typed.length >= 2 && prefix.startsWith(typed)) ??
  offered
    .map((prefix) => ({ prefix, far: distance(typed, prefix) }))
    .filter(({ far }) => far <= 2)
    .sort((a, b) => a.far - b.far)[0]?.prefix

const unknownKind = (text: string, prefix: string, rest: string) => {
  const near = prefix === "" ? undefined : nearest(prefix)
  const kinds = offered.map((one) => `${one}:`).join(", ")
  const hint = near === undefined ? `; kinds: ${kinds}` : `; did you mean ${near}:${singleLine(rest)}? Kinds: ${kinds}`
  return new CliError("validation_error", `"${singleLine(text)}" is no kind of reference${hint}`, {
    reason: "ref.unknown-kind",
  })
}

export const formatReference = (reference: Reference): string =>
  (byType.get(reference.type) as RefKindSpec).format(reference)

export const parseReference = (text: string): Reference => {
  const reference = text.trim()
  const colon = reference.indexOf(":")
  const prefix = colon < 0 ? "" : reference.slice(0, colon)
  const rest = reference.slice(colon + 1)
  const spec = byPrefix.get(prefix)
  if (!spec) throw unknownKind(reference, prefix, rest)
  return spec.parse(rest, reference)
}

/** The stored spelling of a reference, so two spellings of one thing compare equal. */
export const canonicalReference = (text: string): string => formatReference(parseReference(text))

/**
 * Strict: the whole text is one reference of a known kind, with no space. A title such as "Note: plan" is not, so an
 * argument that takes either a reference or a title can tell them apart. The shape is checked only by parsing it.
 */
export const looksLikeReference = (text: string): boolean => {
  const match = /^([a-z]+):\S+$/.exec(text.trim())
  return match !== null && byPrefix.has(match[1] as string)
}
