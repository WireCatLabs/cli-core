import { CliError } from "@wirecat/cli-core"
import { dispatchMeetingMutation, type MeetingMutationOptions } from "./meeting-management.js"
import { type MeetingProviderScope, snapshotMeetingScope } from "./provider.js"

/** Mirrors the store's fact types; the store checks the type again when it writes. */
export const MEETING_FACT_TYPES = ["fact", "statement", "question", "decision", "promise"] as const

export type MeetingContextChange =
  | { action: "note.add"; text: string; title?: string }
  | { action: "tags.add" | "tags.remove"; tags: readonly string[] }
  | {
      action: "memory.add"
      body: string
      kind: "summary" | "digest" | "preference"
      scope: "personal" | "work"
      evidence: readonly string[]
      subject?: string
    }
  | {
      action: "fact.add"
      statement: string
      type: (typeof MEETING_FACT_TYPES)[number]
      scope: "personal" | "work"
      evidence: readonly string[]
      subject?: string
    }
  | { action: "event.link"; eventId: number | null; expectedEventId?: number | null }
  | {
      action: "person.link"
      participantId: number
      personUid: string
      targetAccountIds?: readonly number[]
      expectedPersonUid?: string | null
    }

export type MeetingContextAction = MeetingContextChange["action"]

export interface MeetingContextOperation {
  readonly scope: Readonly<MeetingProviderScope>
  readonly accountId: number
  signal?: AbortSignal
}

export interface MeetingContextPorts<T> {
  readonly actions: readonly MeetingContextAction[]
  /** The adapter checks ownership/evidence again when applying, and returns a durable receipt. */
  apply(meetingId: number, change: Readonly<MeetingContextChange>, context: MeetingContextOperation): Promise<T>
}

export interface MeetingContextReceipt<T> extends MeetingContextOperation {
  meetingId: number
  change: Readonly<MeetingContextChange>
  applied: boolean
  result?: T
}

const id = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new CliError("validation_error", "meeting context identifiers must be positive integers")
  return value
}

const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new CliError("validation_error", `meeting context text must contain 1–${max} characters without NUL`)
  return value.trim()
}

const uid = (value: unknown): string => {
  const result = text(value, 100)
  if (!/^[1-9]\d*$/.test(result) || !Number.isSafeInteger(Number(result)))
    throw new CliError("validation_error", "person UID must be a positive integer")
  return result
}

const strings = (value: unknown, count: number, length: number): readonly string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > count)
    throw new CliError("validation_error", `meeting context list must contain 1–${count} entries`)
  return Object.freeze([...new Set(value.map((entry) => text(entry, length)))])
}

const fields: Record<MeetingContextAction, readonly string[]> = {
  "note.add": ["text", "title"],
  "tags.add": ["tags"],
  "tags.remove": ["tags"],
  "memory.add": ["body", "kind", "scope", "evidence", "subject"],
  "fact.add": ["statement", "type", "scope", "evidence", "subject"],
  "event.link": ["eventId", "expectedEventId"],
  "person.link": ["participantId", "personUid", "targetAccountIds", "expectedPersonUid"],
}

export const validateMeetingContextChange = (change: MeetingContextChange): Readonly<MeetingContextChange> => {
  if (
    !change ||
    typeof change !== "object" ||
    Array.isArray(change) ||
    !Object.hasOwn(fields, change.action) ||
    Object.keys(change).some((key) => key !== "action" && !fields[change.action].includes(key))
  )
    throw new CliError("validation_error", "unsupported meeting context change")
  switch (change.action) {
    case "note.add":
      return Object.freeze({
        action: change.action,
        text: text(change.text, 100_000),
        ...(change.title === undefined ? {} : { title: text(change.title, 500) }),
      })
    case "tags.add":
    case "tags.remove":
      return Object.freeze({ action: change.action, tags: strings(change.tags, 100, 200) })
    case "memory.add": {
      if (!["summary", "digest", "preference"].includes(change.kind) || !["personal", "work"].includes(change.scope))
        throw new CliError("validation_error", "memory kind and explicit personal/work scope are required")
      return Object.freeze({
        action: change.action,
        body: text(change.body, 20_000),
        kind: change.kind,
        scope: change.scope,
        evidence: strings(change.evidence, 100, 4000),
        ...(change.subject === undefined ? {} : { subject: text(change.subject, 4000) }),
      })
    }
    case "fact.add": {
      if (!MEETING_FACT_TYPES.includes(change.type) || !["personal", "work"].includes(change.scope))
        throw new CliError(
          "validation_error",
          `fact type (${MEETING_FACT_TYPES.join(", ")}) and explicit personal/work scope are required`,
        )
      return Object.freeze({
        action: change.action,
        statement: text(change.statement, 20_000),
        type: change.type,
        scope: change.scope,
        evidence: strings(change.evidence, 100, 4000),
        ...(change.subject === undefined ? {} : { subject: text(change.subject, 4000) }),
      })
    }
    case "event.link":
      return Object.freeze({
        action: change.action,
        eventId: change.eventId === null ? null : id(change.eventId),
        ...(change.expectedEventId === undefined
          ? {}
          : { expectedEventId: change.expectedEventId === null ? null : id(change.expectedEventId) }),
      })
    case "person.link": {
      const targets = change.targetAccountIds
      if (targets !== undefined && (!Array.isArray(targets) || targets.length < 1 || targets.length > 1000))
        throw new CliError("validation_error", "target accounts must contain 1–1000 identifiers")
      return Object.freeze({
        action: change.action,
        participantId: id(change.participantId),
        personUid: uid(change.personUid),
        ...(targets === undefined ? {} : { targetAccountIds: Object.freeze([...new Set(targets.map(id))]) }),
        ...(change.expectedPersonUid === undefined
          ? {}
          : { expectedPersonUid: change.expectedPersonUid === null ? null : uid(change.expectedPersonUid) }),
      })
    }
  }
}

export const createMeetingContext = <T>(
  scope: MeetingProviderScope,
  accountId: number,
  ports: MeetingContextPorts<T>,
) => {
  const fixed = snapshotMeetingScope(scope)
  const account = id(accountId)
  const actions = Object.freeze([...new Set(ports.actions)])
  if (actions.some((action) => !Object.hasOwn(fields, action)))
    throw new CliError("validation_error", "unsupported meeting context capability")
  const apply = ports.apply.bind(ports)
  return {
    scope: fixed,
    accountId: account,
    actions,
    async change(
      meetingId: number,
      input: MeetingContextChange,
      options: MeetingMutationOptions = {},
    ): Promise<MeetingContextReceipt<T>> {
      const target = id(meetingId)
      const change = validateMeetingContextChange(input)
      if (!actions.includes(change.action))
        throw new CliError("provider_unavailable", `meeting context does not support ${change.action}`)
      const context = Object.freeze({
        scope: fixed,
        accountId: account,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const outcome = await dispatchMeetingMutation(options, () => apply(target, change, context))
      return {
        scope: fixed,
        accountId: account,
        meetingId: target,
        change,
        applied: outcome.applied,
        ...(outcome.applied ? { result: outcome.value as T } : {}),
      }
    },
  }
}
