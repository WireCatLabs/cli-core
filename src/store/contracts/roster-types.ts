import type { GroupMember, Id } from "../../domain/models.js"

export interface RosterRead {
  observation?: { observedAt: string; startedAt?: string; source: "remote_fetch" | "remote_update" }
  members: GroupMember[]
  /** Every member was read: only then can someone missing be recorded as gone. */
  complete: boolean
  /** The messenger's own count, where it gave one. */
  participants: number | null
}

export interface RosterChange {
  joined: Id[]
  gone: Id[]
  /** Whose profile differs from the one last seen. */
  changed: Id[]
}

export interface MemberStay {
  id: Id
  name: string | null
  username: string | null
  /** ISO 8601. */
  firstSeenAt: string
  lastSeenAt: string
  joinedAt: string | null
  invitedBy: Id | null
  role: string | null
  goneAt: string | null
}

export interface MemberCount {
  day: string
  participants: number | null
  listed: number
  complete: boolean
}

export interface ProfileRevision {
  id: Id
  name: string | null
  username: string | null
  description: string | null
  marks: Record<string, boolean>
  capturedAt: string
}

export interface TrackedChat {
  chatId: Id
  title: string | null
  trackedAt: string
  lastCount: MemberCount | null
}
