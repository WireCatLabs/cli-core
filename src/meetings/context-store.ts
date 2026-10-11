export interface MeetingEventLinkInput {
  accountId: number
  meetingId: number
  eventId: number | null
  expectedEventId?: number | null
  now: number
  signal?: AbortSignal
}

export interface MeetingEventLinkReceipt {
  meetingId: number
  eventId: number | null
  previousEventId: number | null
  changed: boolean
}

export interface ParticipantPersonInput {
  accountId: number
  meetingId: number
  participantId: number
  maxReadBytes?: number
  signal?: AbortSignal
}

export interface ParticipantPerson {
  meetingId: number
  participantId: number
  personUid: string | null
}

export interface ParticipantPersonLinkInput extends ParticipantPersonInput {
  personUid: string
  /** Explicitly authorized additional account observations for the target person. */
  targetAccountIds?: readonly number[]
  expectedPersonUid?: string | null
  now: number
  author: "owner" | "agent"
}

export interface ParticipantPersonLinkReceipt extends ParticipantPerson {
  personUid: string
  previousPersonUid: string | null
  changed: boolean
}

/** Mutations must check live scoped ownership, preconditions and targets in the same transaction. */
export interface MeetingContextStore {
  linkMeetingEvent(input: MeetingEventLinkInput): Promise<MeetingEventLinkReceipt>
  participantPerson(input: ParticipantPersonInput): Promise<ParticipantPerson>
  /** Moves only the participant's identity; never merges entire people by a display name. */
  linkParticipantPerson(input: ParticipantPersonLinkInput): Promise<ParticipantPersonLinkReceipt>
}
