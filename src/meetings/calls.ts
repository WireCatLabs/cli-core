import type { MeetingStatsSelection } from "./stats.js"

export const CALL_DIRECTIONS = ["incoming", "outgoing", "internal"] as const
export type CallDirection = (typeof CALL_DIRECTIONS)[number]
export const CALL_OUTCOMES = ["answered", "voicemail", "busy", "no_answer", "failed"] as const
export type CallOutcome = (typeof CALL_OUTCOMES)[number]
/** The outcomes of an incoming call nobody took: what a business calls back. */
export const MISSED_OUTCOMES: readonly CallOutcome[] = ["voicemail", "busy", "no_answer"]

/** One participant of a stored call, as the store keeps it. */
export interface StoredCallParticipant {
  identityId: number
  /** The identity's external id: `phone:+34…`, `number:…`, `extension:<profile>/101`, `abonent:…`. */
  identityKey: string
  role: string | null
  name: string | null
  /** The provider's own id for the participant; a PBX gives the extension number. */
  externalId: string | null
}

/** One stored meeting as the call reader needs it: its metadata unparsed, its people. */
export interface StoredCall {
  meetingId: number
  startedAt: number | null
  /** The meeting's own duration column. */
  durationMs: number | null
  metadata: unknown
  participants: readonly StoredCallParticipant[]
}

/** An employee on a call: by extension where the provider names one, else by the stored identity. */
export interface CallEmployee {
  /** `extension:<number>` or `identity:<id>`. */
  key: string
  name: string | null
  identityId: number | null
  extension: string | null
}

export interface CallClient {
  /** The identity's external id, `phone:+E164` or `number:<raw>`: the same client on every call. */
  key: string
  name: string | null
  identityId: number
}

/** A meeting read as a phone call. A field the provider does not give is `null`, never a guess. */
export interface Call {
  meetingId: number
  startedAt: number | null
  direction: CallDirection | null
  outcome: CallOutcome | null
  /** From the first ring to the first answer. */
  waitMs: number | null
  /** From the first answer to the end. */
  talkMs: number | null
  durationMs: number | null
  client: CallClient | null
  placedBy: CallEmployee | null
  /** Whether the provider says who placed, answered and rang; when not, those three are empty and unknown. */
  roles: boolean
  /** In the order they answered. */
  answeredBy: CallEmployee[]
  /** Rang and did not answer. */
  rang: CallEmployee[]
  /** Everyone of the business on the call: who placed it, answered, rang, or the provider lists as its manager. */
  employees: CallEmployee[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const milliseconds = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null

const word = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null)

// Beeline writes INBOUND and OUTBOUND.
const DIRECTION_WORDS: Record<string, CallDirection> = {
  incoming: "incoming",
  inbound: "incoming",
  outgoing: "outgoing",
  outbound: "outgoing",
  internal: "internal",
}

const directionOf = (value: unknown) => {
  const found = word(value)?.toLowerCase()
  return found === undefined ? null : (DIRECTION_WORDS[found] ?? null)
}

const outcomeOf = (value: unknown): CallOutcome | null => {
  const found = word(value)
  return found && (CALL_OUTCOMES as readonly string[]).includes(found) ? (found as CallOutcome) : null
}

const numbers = (value: unknown) =>
  Array.isArray(value) ? value.map(word).filter((one): one is string => one !== null) : []

/**
 * A stored meeting as a call, or `null` when it is not one: a call has a direction or an outcome a phone system
 * writes, or a participant whose role is `client`. Keys may be missing or of the wrong type; each such field is
 * `null`. Wait and talk come only from the provider's own `waitMs` and `talkMs`: a recording's length is not talk.
 */
export const callOf = (stored: StoredCall): Call | null => {
  const metadata = isRecord(stored.metadata) ? stored.metadata : {}
  const direction = directionOf(metadata.direction)
  const outcome = outcomeOf(metadata.outcome)
  const clientParticipant = stored.participants.find((one) => one.role === "client")
  if (direction === null && outcome === null && !clientParticipant) return null
  const managers = stored.participants.filter((one) => one.role === "manager")
  const byExtension = (number: string): CallEmployee => {
    const found = managers.find((one) => one.externalId === number)
    return {
      key: `extension:${number}`,
      name: found?.name ?? null,
      identityId: found?.identityId ?? null,
      extension: number,
    }
  }
  const placed = word(metadata.placedBy)
  const answeredBy = numbers(metadata.answeredBy).map(byExtension)
  const rang = numbers(metadata.rang).map(byExtension)
  const placedBy = placed === null ? null : byExtension(placed)
  const named = [placedBy, ...answeredBy, ...rang].filter((one): one is CallEmployee => one !== null)
  const listed = managers
    .filter((one) => !named.some((employee) => employee.identityId === one.identityId))
    .map(
      (one): CallEmployee => ({
        key: `identity:${one.identityId}`,
        name: one.name,
        identityId: one.identityId,
        extension: one.externalId,
      }),
    )
  const employees = [...new Map([...named, ...listed].map((one) => [one.key, one])).values()]
  return {
    meetingId: stored.meetingId,
    startedAt: stored.startedAt,
    direction,
    outcome,
    waitMs: milliseconds(metadata.waitMs),
    talkMs: milliseconds(metadata.talkMs),
    durationMs: milliseconds(metadata.durationMs) ?? milliseconds(stored.durationMs),
    client: clientParticipant
      ? { key: clientParticipant.identityKey, name: clientParticipant.name, identityId: clientParticipant.identityId }
      : null,
    placedBy,
    roles: ["placedBy", "answeredBy", "rang"].some((key) => key in metadata),
    answeredBy,
    rang,
    employees,
  }
}

export interface MeetingCallsInput extends MeetingStatsSelection {
  /** Most meetings to read (default 200000); more is an error, never a silent cut. */
  maxRows?: number
}

export interface MeetingCallsStore {
  /** The selected meetings with their metadata and people, oldest first; the caller reads which are calls. */
  meetingCalls(input: MeetingCallsInput): Promise<StoredCall[]>
}
