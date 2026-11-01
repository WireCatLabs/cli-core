import { dateRange, parseLucene, type QueryNode, timezoneOf } from "@wirecat/cli-base/query"
import { validateFields } from "../search/lucene/registry.js"
import { MESSAGE_PARSING } from "../search/lucene/types.js"

/**
 * What a mail server is asked, in no server's syntax: every part must hold. Each list is AND-ed; a part the server
 * cannot read is left out, which only widens the candidates, since the strict query on the store decides.
 */
export interface MailCriteria {
  /** Words and phrases anywhere in the email. */
  words: string[]
  from: string[]
  to: string[]
  cc: string[]
  subject: string[]
  body: string[]
  /** Received at or after this time, in ms. */
  since?: number
  /** Received before this time, in ms. */
  before?: number
  seen?: boolean
  flagged?: boolean
}

const DAY = 86_400_000

const empty = (): MailCriteria => ({ words: [], from: [], to: [], cc: [], subject: [], body: [] })

/** Whether the criteria narrow at all: a server asked for everything would only return the newest mail. */
export const narrows = (criteria: MailCriteria): boolean =>
  criteria.words.length +
    criteria.from.length +
    criteria.to.length +
    criteria.cc.length +
    criteria.subject.length +
    criteria.body.length >
    0 ||
  criteria.since !== undefined ||
  criteria.before !== undefined ||
  criteria.seen !== undefined ||
  criteria.flagged !== undefined

const merge = (one: MailCriteria, other: MailCriteria): MailCriteria | undefined => {
  if (one.seen !== undefined && other.seen !== undefined && one.seen !== other.seen) return undefined
  if (one.flagged !== undefined && other.flagged !== undefined && one.flagged !== other.flagged) return undefined
  const since = Math.max(one.since ?? -Infinity, other.since ?? -Infinity)
  const before = Math.min(one.before ?? Infinity, other.before ?? Infinity)
  const seen = one.seen ?? other.seen
  const flagged = one.flagged ?? other.flagged
  return {
    words: [...one.words, ...other.words],
    from: [...one.from, ...other.from],
    to: [...one.to, ...other.to],
    cc: [...one.cc, ...other.cc],
    subject: [...one.subject, ...other.subject],
    body: [...one.body, ...other.body],
    ...(Number.isFinite(since) ? { since } : {}),
    ...(Number.isFinite(before) ? { before } : {}),
    ...(seen === undefined ? {} : { seen }),
    ...(flagged === undefined ? {} : { flagged }),
  }
}

const TEXT_FIELDS = { from: "from", to: "to", cc: "cc", subject: "subject", body: "body" } as const

const leafOf = (node: QueryNode & { kind: "predicate" }, timezone: string): MailCriteria => {
  const criteria = empty()
  const plain = node.operator === "term" || node.operator === "phrase"
  if ((node.field === "text" || node.field === "exact") && plain && node.value !== "")
    return { ...criteria, words: [node.value] }
  const field = TEXT_FIELDS[node.field as keyof typeof TEXT_FIELDS]
  // `from:me` is the mailbox's own address, which the store knows and the server's FROM does not.
  if (field && plain && node.value !== "" && !(field === "from" && node.value.toLowerCase() === "me"))
    return { ...criteria, [field]: [node.value] }
  if (node.field === "is" && node.operator === "term") {
    const state = node.value.toLowerCase()
    if (state === "unread") return { ...criteria, seen: false }
    if (state === "read") return { ...criteria, seen: true }
    if (state === "starred") return { ...criteria, flagged: true }
  }
  if (node.field === "date") {
    const range = dateRange(
      node.value,
      node.operator === "range" ? (node.upper ?? "*") : node.value,
      node.operator === "range" ? node.lower_inclusive === true : true,
      node.operator === "range" ? node.upper_inclusive === true : true,
      timezone,
      node.span,
    )
    // A server reads whole days in its own zone: a day more each side, and the store cuts to the exact moment.
    return {
      ...criteria,
      ...(range.lower === undefined ? {} : { since: range.lower - DAY }),
      ...(range.upper === undefined ? {} : { before: range.upper + DAY }),
    }
  }
  return criteria
}

const branchesOf = (node: QueryNode, timezone: string): MailCriteria[] => {
  if (node.kind === "predicate") return [leafOf(node, timezone)]
  const must = node.clauses.filter(({ occur }) => occur === "must")
  if (must.length)
    return must.reduce<MailCriteria[]>(
      (product, { node }) =>
        product.flatMap((one) => branchesOf(node, timezone).flatMap((other) => merge(one, other) ?? [])),
      [empty()],
    )
  const should = node.clauses.filter(({ occur }) => occur === "should")
  return should.length ? should.flatMap(({ node }) => branchesOf(node, timezone)) : [empty()]
}

/**
 * The shared query as mail server searches, one per top-level OR branch. Negations, patterns, `has:`, `list:`,
 * `mailbox:` and the rest stay with the strict query on the store. A branch that narrows nothing is not sent, since a
 * server asked for everything would only answer the newest mail; `partial` says one was left out.
 */
export const mailCriteriaOf = (
  text: string,
  { exact, timezone }: { exact?: boolean; timezone?: string } = {},
): { branches: MailCriteria[]; partial: boolean } => {
  const ast = validateFields(parseLucene(text, { ...MESSAGE_PARSING, defaultField: exact ? "exact" : "text" }))
  const all = branchesOf(ast.root, timezoneOf(timezone))
  const sent = all.filter(narrows)
  return {
    branches: [...new Map(sent.map((branch) => [JSON.stringify(branch), branch])).values()],
    partial: sent.length < all.length,
  }
}
