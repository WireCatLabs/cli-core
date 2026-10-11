import { CliError } from "@wirecat/cli-base"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { GroupMember, Id, Message } from "../domain/models.js"
import type { GroupRules } from "./rules.js"

export type Action = "report" | "delete" | "remove"

export type Outcome = "reported" | "done" | "planned" | "forbidden" | "declined" | "refused" | "failed" | "skipped"

export interface Finding {
  /** A message, or somebody who joined. */
  kind: "message" | "member"
  rule: "blocked" | "invites" | "links" | "forwards" | "flood" | "newAccount"
  personId: Id
  personName: string | null
  messageId?: Id
  action: Action
}

export interface CheckRow extends Finding {
  outcome: Outcome
  reason?: string
  /** What the owner types to do it by hand, on a row that was not done. */
  command?: string
}

export interface CheckInput {
  rules: GroupRules
  messages: Message[]
  joined: GroupMember[]
  /** The group's admins; the owner's own messages are known by `outgoing`. */
  answerers: ReadonlySet<Id>
  /** Service messages — someone joined, the title changed — which no rule judges. */
  service: ReadonlySet<Id>
  now: number
  /** The messenger's own invite links, found beside the built-in Telegram and MAX ones. */
  invites?: RegExp
}

const INVITE = /max\.ru\/join\/|(t|telegram)\.me\/(\+|joinchat\/)|tg:\/\/join/i
const LINK = /https?:\/\/\S+/i

/** Which action wins when a message breaks several rules; the first rule listed breaks a tie. */
const STRENGTH: Record<GroupRules["links"], number> = { report: 0, delete: 1, remove: 2 }

/**
 * What the rules say about what is new. Pure: nothing here talks to a messenger. One finding per
 * message — the rule with the strongest action — and one removal per person, whatever else they did.
 */
export const judge = ({ rules, messages, joined, answerers, service, now, invites }: CheckInput): Finding[] => {
  const invite = invites ? new RegExp(`${INVITE.source}|${invites.source}`, "i") : INVITE
  const trusted = new Set(rules.trusted)
  const blocked = (id: Id | null, name: string | null) =>
    (id !== null && rules.blocked.includes(id)) ||
    (name !== null && rules.blockedNames.some((part) => name.toLocaleLowerCase().includes(part.toLocaleLowerCase())))
  const young = (member: GroupMember) =>
    rules.newAccount.days > 0 &&
    typeof member.registeredAt === "string" &&
    now - Date.parse(member.registeredAt) < rules.newAccount.days * 86_400_000

  const found: Finding[] = []
  const add = (finding: Finding) => {
    if (finding.action === "remove" && found.some((f) => f.action === "remove" && f.personId === finding.personId)) {
      return
    }
    found.push(finding)
  }

  for (const member of joined) {
    if (trusted.has(member.id) || answerers.has(member.id)) continue
    const person = { kind: "member" as const, personId: member.id, personName: member.name }
    if (blocked(member.id, member.name)) {
      add({ ...person, rule: "blocked", action: rules.blockedPeople === "remove" ? "remove" : "report" })
    } else if (young(member)) {
      add({ ...person, rule: "newAccount", action: rules.newAccount.action })
    }
  }

  const flooding = floodOf(messages, rules.flood)
  for (const message of messages) {
    const id = message.senderId
    if (id === null || message.outgoing === true || answerers.has(id) || trusted.has(id)) continue
    if (service.has(message.id) || message.attachments.some((attachment) => attachment.kind === "control")) continue
    const base = { kind: "message" as const, personId: id, personName: message.senderName, messageId: message.id }
    const text = message.text
    const broken: [Finding["rule"], GroupRules["links"]][] = []
    if (blocked(id, message.senderName)) broken.push(["blocked", rules.blockedPeople])
    if (invite.test(text)) broken.push(["invites", rules.invites])
    if (LINK.test(text) || message.attachments.some((attachment) => attachment.kind === "share")) {
      broken.push(["links", rules.links])
    }
    if (message.forwardedFrom !== null) broken.push(["forwards", rules.forwards])
    if (flooding.has(message.id)) broken.push(["flood", rules.flood.action])
    const strongest = broken.reduce<(typeof broken)[number] | undefined>(
      (best, rule) => (best === undefined || STRENGTH[rule[1]] > STRENGTH[best[1]] ? rule : best),
      undefined,
    )
    if (strongest) add({ ...base, rule: strongest[0], action: strongest[1] })
  }
  return found
}

/** Messages past the limit: more than `messages` from one person within `minutes`. */
const floodOf = (messages: Message[], flood: GroupRules["flood"]): Set<Id> => {
  const window = flood.minutes * 60_000
  const over = new Set<Id>()
  const bySender = new Map<Id, number[]>()
  for (const message of messages) {
    if (message.senderId === null) continue
    const times = bySender.get(message.senderId) ?? []
    const at = Date.parse(message.timestamp)
    times.push(at)
    bySender.set(message.senderId, times)
    if (times.filter((time) => at - time < window).length > flood.messages) over.add(message.id)
  }
  return over
}

/** The two things a check may do, whoever does them: the personal account, or a bot. */
export interface Moderator {
  deleteMessage(chatId: Id, messageId: Id): Promise<void>
  removePerson(chatId: Id, personId: Id): Promise<void>
}

export interface ActOptions {
  chatId: Id
  rules: GroupRules
  /** `--allow-dangerous`: yes to every action at level `ask`. */
  allowDangerous: boolean
  dryRun: boolean
  maxActions: number
  /** Asks the owner about one action: `undefined` from it, or no `confirm`, when nobody is there to answer. */
  confirm?: (finding: Finding) => Promise<boolean | undefined>
  /** The program's word, for the command a row says to type by hand: `tg`, `max`. */
  command: string
  /** In place of the personal commands a row names: a bot's own. */
  commandFor?: (chatId: Id, finding: Finding) => string
}

/**
 * Does what the findings ask, as far as the group's levels, the per-run limit and the guard let it.
 * `deny` never acts, `readonly` only reports, `ask` asks — or `--allow-dangerous` says yes — and
 * `allow` acts. Stops acting at the first hourly-limit refusal: the rest is `skipped`, never tried.
 */
export const act = async (moderator: Moderator, findings: Finding[], options: ActOptions): Promise<CheckRow[]> => {
  const { chatId, rules, allowDangerous, dryRun, maxActions, confirm, command } = options
  const typed = options.commandFor ?? ((chat: Id, finding: Finding) => commandFor(command, chat, finding))
  const rows: CheckRow[] = []
  let acted = 0
  let stopped: string | undefined

  for (const finding of findings) {
    if (finding.action === "report") {
      rows.push({ ...finding, outcome: "reported" })
      continue
    }
    const consent = finding.action
    const level = rules.consent[consent]
    const row = (outcome: Outcome, reason?: string): CheckRow => ({
      ...finding,
      outcome,
      ...(reason ? { reason } : {}),
      ...(outcome === "done" || outcome === "reported" ? {} : { command: typed(chatId, finding) }),
    })

    if (level === "deny") {
      rows.push(row("forbidden", `consent.${consent} is deny`))
      continue
    }
    if (level === "readonly") {
      rows.push(row("reported", `consent.${consent} is readonly`))
      continue
    }
    if (dryRun) {
      rows.push(row("planned", "--dry-run"))
      continue
    }
    if (stopped || acted >= maxActions) {
      rows.push(row("skipped", stopped ?? `over the limit of ${maxActions} actions per check`))
      continue
    }
    if (level === "ask" && !allowDangerous) {
      const yes = confirm ? await confirm(finding) : undefined
      if (yes === undefined) {
        rows.push(
          row("planned", `consent.${consent} is ask, and nobody is there to answer — run with --allow-dangerous`),
        )
        continue
      }
      if (!yes) {
        rows.push(row("declined", "the answer was no"))
        continue
      }
    }

    acted += 1
    try {
      if (finding.action === "delete" && finding.messageId) {
        await moderator.deleteMessage(chatId, finding.messageId)
      } else {
        await moderator.removePerson(chatId, finding.personId)
      }
      rows.push(row("done"))
    } catch (error) {
      const failure = asCliError(error)
      if (failure.code === "rate_limited") stopped = failure.message
      const refused = ["rate_limited", "permission_error", "confirmation_required"].includes(failure.code)
      rows.push(row(refused ? "refused" : "failed", failure.message))
    }
  }
  return rows
}

const asCliError = (error: unknown): CliError =>
  error instanceof CliError
    ? error
    : new CliError("provider_error", error instanceof Error ? error.message : String(error))

const who = (finding: Finding) => finding.personName ?? finding.personId

/** One action in words, for a question at the terminal. */
export const describe = (finding: Finding): string =>
  finding.action === "delete"
    ? `delete message ${finding.messageId} from ${who(finding)} for everyone (${finding.rule})`
    : `remove ${who(finding)} from the group (${finding.rule})`

const commandFor = (command: string, chatId: Id, finding: Finding): string =>
  finding.action === "delete"
    ? `${command} messages delete ${chatId} ${finding.messageId} --for-everyone --allow-dangerous`
    : finding.action === "remove"
      ? `${command} chats members remove ${chatId} ${finding.personId}`
      : ""

export interface Gathered extends Omit<CheckInput, "rules" | "now"> {
  /** The newest message read, ISO 8601: where the next check starts. */
  until: string | null
  /** More history than one check reads. */
  more: boolean
  notes: string[]
}

/** One check reads at most this many messages; the rest waits for the next. */
export const CHECK_READS = 1000
const PAGE = 100

/**
 * What is new in the group since `since` (ms): its messages, who joined — from the chat's service
 * messages — and who the admins are. Reads only.
 */
export const gather = async (adapter: MessengerAdapter, chatId: Id, since: number): Promise<Gathered> => {
  const notes: string[] = []
  const historyAfter = adapter.historyAfter
  if (!historyAfter) throw new CliError("validation_error", "this messenger cannot read a chat forward from a time")
  const messages: Message[] = []
  let more = true
  while (more && messages.length < CHECK_READS) {
    const last = messages.at(-1)
    const page = await historyAfter.call(adapter, chatId, {
      limit: PAGE,
      after: last ? { id: last.id } : { time: since },
    })
    messages.push(...page.items)
    more = page.hasMore && page.items.length > 0
  }

  const scanned = adapter.chatEvents ? (await adapter.chatEvents(chatId, { since })).events : []
  const until = messages.at(-1)?.timestamp ?? null
  // Event scans may read farther than the capped message batch; those joins belong to the next run.
  const events =
    more && until !== null ? scanned.filter((event) => Date.parse(event.timestamp) <= Date.parse(until)) : scanned
  if (!adapter.chatEvents) notes.push("this messenger does not say who joined, so only messages are judged")
  const joinedIds = new Set(
    events
      .filter((one) => one.event === "join" || one.event === "add")
      .flatMap((one) => (one.people.length > 0 ? one.people.map((person) => person.id) : one.by.id ? [one.by.id] : [])),
  )
  const joined =
    joinedIds.size === 0 || !adapter.members
      ? []
      : (await adapter.members(chatId, { offset: 0 })).items.filter((member) => joinedIds.has(member.id))

  const admins = adapter.admins ? await adapter.admins(chatId) : null
  if (admins === null) notes.push("the group's admins are not known, so only your own messages are exempt")

  return {
    messages,
    joined,
    answerers: new Set(admins ?? []),
    service: new Set(events.map((one) => one.messageId)),
    until,
    more,
    notes,
  }
}

export const MAX_ACTIONS = 10

const undone = (row: CheckRow) => ["planned", "skipped", "failed"].includes(row.outcome)

/**
 * Where the next check starts: after the newest message read, or just before the first message whose
 * action is still undone — so it is judged again, and what came after it is still read. A person
 * who joined and is still undone keeps the point where it was, since the join is not a row's message.
 */
export const nextPoint = (rows: CheckRow[], found: Gathered): string | null => {
  const waiting = rows.filter(undone)
  if (waiting.some((row) => row.messageId === undefined)) return null
  const times = waiting
    .map((row) => found.messages.find((message) => message.id === row.messageId)?.timestamp)
    .filter((time): time is string => time !== undefined)
    .map(Date.parse)
  if (times.length === 0) return found.until
  return new Date(Math.min(...times) - 1).toISOString()
}

export const someUndone = (rows: CheckRow[]): boolean => rows.some(undone)
