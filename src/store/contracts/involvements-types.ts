export interface Involvement {
  personId: number
  identityId: number | null
  subjectType: string
  subjectId: number
  role: string
  occurredAt: number
  scope: string
  accountId: number | null
  projectId: number | null
  /** The account's and the chat's own ids, and the message's, where the subject is a message or a chat. */
  provider: string | null
  account: string | null
  chat: string | null
  message: string | null
}

export interface InvolvementStore {
  /** Every row from scratch, or one person's; `store reindex` runs it, and it empties the queue. */
  rebuild(personId?: number): number
  /** Recomputes what is still queued; every write already does this before it commits. */
  drain(): { recomputed: number; pending: number }
  /** How many changes wait in the queue: more than one write recomputes, left for the next one. */
  pending(): number
  /**
   * `since` and `until` are ms, both inclusive. `only` keeps, of `only.provider`, that one account's rows —
   * another account of the same messenger is somebody else's view; other providers and rows of no account stay.
   */
  forPerson(
    personId: number,
    options?: {
      scope?: string
      since?: number
      until?: number
      only?: { provider: string; account: string }
      limit?: number
    },
  ): Involvement[]
}
