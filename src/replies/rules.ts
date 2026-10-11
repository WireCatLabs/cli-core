import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import * as v from "valibot"
import type { AppIdentity } from "../cli/app.js"

export const REPLY_ACTIONS = ["reply", "task"] as const
export const REPLY_MODELS = ["fill-only", "may-reword"] as const
export type ReplyAction = (typeof REPLY_ACTIONS)[number]
/** Channels, saved messages and chats of unknown kind are never answered, so a rule cannot name them. */
export const REPLY_KINDS = ["dialog", "group"] as const
export const PLACEHOLDERS = ["firstName", "name"] as const
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

export type Day = (typeof DAYS)[number]

const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
const LIMIT = /^([1-9]\d*)\/([1-9]\d*)(m|h|d)$/
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Minutes after midnight, `[from, to)`; `to` below `from` crosses midnight. */
export interface Window {
  from: number
  to: number
}

/** At most `count` sends inside any `ms`. */
export interface Limit {
  count: number
  ms: number
}

const minutes = (hours: string | undefined, mins: string | undefined) => Number(hours) * 60 + Number(mins)

const window = v.pipe(
  v.string(),
  v.regex(WINDOW, 'a window is written "09:00-19:00", 24-hour'),
  v.transform((typed): Window => {
    const [, h1, m1, h2, m2] = WINDOW.exec(typed) as RegExpExecArray
    return { from: minutes(h1, m1), to: minutes(h2, m2) }
  }),
  v.check((one) => one.from !== one.to, "a window has to start and end at different times"),
)

const dayOf = (typed: string): number => DAYS.indexOf(typed as Day)

/** `mon-fri`, `sat,sun`, `fri-mon` across the week's end. */
const days = v.pipe(
  v.string(),
  v.transform((typed): Day[] | undefined => {
    const found = new Set<Day>()
    for (const part of typed.split(",").map((one) => one.trim().toLowerCase())) {
      const [first = "", last = first] = part.split("-")
      const from = dayOf(first)
      const to = dayOf(last)
      if (from < 0 || to < 0) return undefined
      for (let at = from; ; at = (at + 1) % 7) {
        found.add(DAYS[at] as Day)
        if (at === to) break
      }
    }
    return DAYS.filter((day) => found.has(day))
  }),
  v.check((one) => one !== undefined, `days are written "mon-fri" or "sat,sun", from ${DAYS.join(", ")}`),
  v.transform((one) => one as Day[]),
)

const knownZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const timezone = v.pipe(v.string(), v.check(knownZone, 'a time zone is written as "Europe/Madrid"'))

const limit = v.pipe(
  v.string(),
  v.regex(LIMIT, 'a limit is written "1/12h": this many replies in this long — m, h or d'),
  v.transform((typed): Limit => {
    const [, count, amount, unit] = LIMIT.exec(typed) as RegExpExecArray
    return { count: Number(count), ms: Number(amount) * (UNIT_MS[unit ?? ""] ?? 0) }
  }),
)

const ids = v.array(v.pipe(v.string(), v.minLength(1)))

const template = v.pipe(
  v.string(),
  v.check(
    (text) => [...text.matchAll(/(?<!\{)\{(\w*)\}(?!\})/g)].every(([, name]) => PLACEHOLDERS.includes(name as never)),
    `a template fills only ${PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
  ),
)

const rule = v.pipe(
  v.strictObject({
    id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, "a rule id is lower-case letters, digits and -")),
    on: v.boolean(),
    do: v.pipe(v.array(v.picklist(REPLY_ACTIONS)), v.minLength(1, "a rule has to do something: reply")),
    where: v.strictObject({ kinds: v.array(v.picklist(REPLY_KINDS)), chats: ids, notChats: ids }),
    when: v.strictObject({
      hours: v.nullable(v.strictObject({ outside: window, days, timezone })),
      words: v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
      question: v.boolean(),
      mentionsMe: v.boolean(),
      from: v.strictObject({ people: ids, notPeople: ids, contactsOnly: v.boolean() }),
    }),
    reply: v.strictObject({ template, model: v.optional(v.picklist(REPLY_MODELS), "fill-only"), asReply: v.boolean() }),
    limits: v.strictObject({ perChat: limit, perPerson: limit }),
  }),
  v.forward(
    v.check(
      (one) => !one.on || !one.do.includes("reply") || one.reply.template.trim().length > 0,
      "an enabled reply rule needs a nonempty template — edit its template before turning it on",
    ),
    ["reply", "template"],
  ),
)

export type ReplyRule = v.InferOutput<typeof rule>
export type ReplyRuleFile = v.InferInput<typeof rule>

const legacyTester = v.strictObject({
  provider: v.optional(v.pipe(v.string(), v.minLength(1))),
  id: v.pipe(v.string(), v.minLength(1)),
})

const side = v.optional(v.strictObject({ people: v.optional(ids, []), chats: v.optional(ids, []) }), {
  people: [],
  chats: [],
})

/**
 * Who may get an answer at all, whatever a rule says: everyone, or only those listed in `allow`; and
 * never anyone in `deny`, which wins when an id is in both. Tasks are not limited by it. A file that
 * does not say answers everyone a rule matches; `replies.send` is what keeps a new file silent.
 */
const audienceShape = v.optional(
  v.strictObject({ reply: v.optional(v.picklist(["all", "listed"]), "all"), allow: side, deny: side }),
  { reply: "all", allow: { people: [], chats: [] }, deny: { people: [], chats: [] } },
)

export type Audience = v.InferOutput<typeof audienceShape>

const file = v.pipe(
  v.strictObject({ audience: audienceShape, rules: v.array(rule) }),
  v.check(
    ({ rules }) => new Set(rules.map((one) => one.id)).size === rules.length,
    "two rules share an id; each needs its own",
  ),
)

/**
 * Every key written out, so the file shows all there is to set, as moderation's does (max-cli
 * `NEED-314`). Off until the owner turns it on, and the limits are the tightest worth having.
 */
export const defaultRule = (id: string): ReplyRuleFile => ({
  id,
  on: false,
  do: ["reply"],
  where: { kinds: ["dialog"], chats: [], notChats: [] },
  when: {
    hours: null,
    words: [],
    question: false,
    mentionsMe: false,
    from: { people: [], notPeople: [], contactsOnly: false },
  },
  reply: { template: "", asReply: true },
  limits: { perChat: "1/1d", perPerson: "1/1d" },
})

export const repliesPathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config, `${profile}.replies.json`)

export interface Replies {
  audience: Audience
  rules: ReplyRule[]
}

export const EVERYONE: Audience = { reply: "all", allow: { people: [], chats: [] }, deny: { people: [], chats: [] } }

/** Why nobody may be answered here, or `null` when the audience lets the reply go. */
export const outsideAudience = (audience: Audience, person: string | null, chat: string): string | null => {
  if (person !== null && audience.deny.people.includes(person)) return "a person on the deny list"
  if (audience.deny.chats.includes(chat)) return "a chat on the deny list"
  if (audience.reply === "all") return null
  const listed = (person !== null && audience.allow.people.includes(person)) || audience.allow.chats.includes(chat)
  return listed ? null : "not on the allow list"
}

/** What in the audience does not do what it seems to say — said, never refused. */
export const audienceWarnings = ({ reply, allow, deny }: Audience): string[] => [
  ...allow.people
    .filter((id) => deny.people.includes(id))
    .map((id) => `person ${id} is on both lists: deny wins, nobody answers them`),
  ...allow.chats
    .filter((id) => deny.chats.includes(id))
    .map((id) => `chat ${id} is on both lists: deny wins, nothing is answered there`),
  ...(reply === "all" && allow.people.length + allow.chats.length > 0
    ? ['the allow list does nothing while audience.reply is "all" — set it to "listed" to answer only those']
    : []),
  ...(reply === "listed" && allow.people.length + allow.chats.length === 0
    ? ['audience.reply is "listed" and the allow list is empty: nobody is answered']
    : []),
]

/** The owner's rules, in file order. No file is no rules; a file that does not check out refuses, naming the field. */
export const readReplyRules = (path: string): ReplyRule[] => readReplies(path, "").rules

/** `provider`: the messenger reading the file, which an older file's `testers` may have named. */
export const readReplies = (path: string, provider: string): Replies => {
  return parseReplies(readRepliesFile(path, provider), path, provider)
}

export interface RepliesFile {
  audience: Audience
  rules: ReplyRuleFile[]
}

// Hours and limits are transformed by parsing; editing must keep their file input forms.
export const readRepliesFile = (path: string, provider: string): RepliesFile => {
  if (!existsSync(path)) return { audience: structuredClone(EVERYONE), rules: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw broken(path, error instanceof Error ? error.message : String(error))
  }
  const upgraded = withoutTesters(parsed, provider, path)
  const checked = parseReplies(upgraded, path, provider)
  return { ...(upgraded as RepliesFile), audience: checked.audience }
}

/**
 * A file from before the audience took over still has `testers`: then a reply went only to a sender
 * who was a tester (with no `provider`, or this one) and also inside the audience. The audience that
 * answers exactly them is `listed` with the testers as its people — under `listed` already, only the
 * testers its people list also names. Its allowed chats are dropped: "a tester in this chat" has no
 * audience form, and keeping a chat would answer everyone in it. Deny lists stay. No testers, nobody.
 * Read here on every load; the next edit writes the result back.
 */
const withoutTesters = (parsed: unknown, provider: string, path: string): unknown => {
  if (typeof parsed !== "object" || parsed === null || !("testers" in parsed)) return parsed
  const { testers, ...rest } = parsed as { testers: unknown; audience?: unknown }
  const named = v.safeParse(v.array(legacyTester), testers)
  if (!named.success) throw broken(path, `testers: ${named.issues.map((issue) => issue.message).join("; ")}`)
  const ids = [
    ...new Set(
      named.output.filter((one) => one.provider === undefined || one.provider === provider).map((one) => one.id),
    ),
  ]
  const audience = (rest.audience ?? {}) as { reply?: unknown; allow?: { people?: unknown } }
  if (
    typeof audience !== "object" ||
    audience === null ||
    ![undefined, "all", "listed"].includes(audience.reply as string)
  )
    return rest
  const listed = Array.isArray(audience.allow?.people) ? (audience.allow.people as unknown[]) : []
  const people = audience.reply === "listed" ? ids.filter((id) => listed.includes(id)) : ids
  return { ...rest, audience: { ...audience, reply: "listed", allow: { people, chats: [] } } }
}

export const writeRepliesFile = (path: string, contents: RepliesFile): void => {
  const checked = v.safeParse(file, contents)
  if (!checked.success) {
    throw new CliError("validation_error", `reply edit cannot be saved (${checked.issues.map(problem).join("; ")})`)
  }
  writeSecurely(path, `${JSON.stringify(contents, null, 2)}\n`, 0o600)
}

export const parseReplyRules = (parsed: unknown, path: string): ReplyRule[] => parseReplies(parsed, path, "").rules

export const parseReplies = (parsed: unknown, path: string, provider: string): Replies => {
  const checked = v.safeParse(file, withoutTesters(parsed, provider, path))
  if (!checked.success) throw broken(path, checked.issues.map(problem).join("; "))
  return checked.output
}

const problem = (issue: v.BaseIssue<unknown>): string => {
  const at = v.getDotPath(issue) ?? "the file"
  if (issue.kind === "schema" && issue.expected === "never") return `${at} is not a field a rule has`
  if (issue.expected === "Object" && issue.received === "undefined") return `${at} is missing`
  return `${at}: ${issue.message}`
}

const broken = (path: string, why: string) =>
  new CliError("configuration_error", `the reply rules ${path} cannot be read (${why}) — fix the file`)
