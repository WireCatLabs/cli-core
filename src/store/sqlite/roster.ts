import { CliError } from "@wirecat/cli-base"
import type { GroupMember, Id, Provider } from "../../domain/models.js"
import { and, asc, eq, gte, inArray, isNotNull, isNull, or, sql } from "./drizzle/core.js"
import { identityPk, seenIdentity } from "./identities.js"
import type { StoreContext } from "./open.js"
import { chatMembers, chats, identities, identityRevisions, memberCounts, memberStays } from "./schema.js"

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

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

const marksOf = ({ isBot, flagged, deleted, hasPhoto }: GroupMember): Record<string, boolean> => ({
  ...(isBot === undefined ? {} : { bot: isBot }),
  ...(flagged === undefined ? {} : { [flagged]: true }),
  ...(deleted === undefined ? {} : { deleted }),
  ...(hasPhoto === undefined ? {} : { photo: hasPhoto }),
})

/** Stays opened, closed and kept, profiles revised, today's count — one read of a member list, in one transaction. */
export const saveRoster = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  chatKey: number,
  { members, complete, participants, observation }: RosterRead,
): RosterChange => {
  const { orm, now } = context
  const at = now()
  const observedAt = observation ? Date.parse(observation.observedAt) : at
  const startedAt = observation?.startedAt ? Date.parse(observation.startedAt) : null
  if (
    observation &&
    (!Number.isSafeInteger(observedAt) ||
      observedAt < 0 ||
      observedAt > at ||
      (startedAt !== null && (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > observedAt)) ||
      !["remote_fetch", "remote_update"].includes(observation.source))
  )
    throw new CliError("validation_error", "member observation requires a valid nonfuture timestamp and remote source")
  const latest = context.database
    .prepare("SELECT max(max(last_seen_at,coalesce(left_at,last_seen_at))) AS at FROM member_stays WHERE chat_id=?")
    .get(chatKey)
  if (observation && latest?.at !== null && latest?.at !== undefined && observedAt < Number(latest.at))
    throw new CliError("validation_error", "member observation predates the latest saved roster")
  if (new Set(members.map((member) => member.id)).size !== members.length)
    throw new CliError("validation_error", "member roster contains duplicate identities")
  const observationId = observation
    ? Number(
        context.database
          .prepare(
            "INSERT INTO member_observations (chat_id, observed_at, started_at, complete, reported_count, listed_count, source, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          )
          .get(
            chatKey,
            observedAt,
            startedAt,
            complete ? 1 : 0,
            participants,
            members.length,
            observation.source,
            at,
            at,
          )?.id,
      )
    : undefined
  const recordMember = (person: number, stay: number) => {
    if (observationId !== undefined)
      context.database
        .prepare(
          "INSERT INTO member_observation_members (member_observation_id, identity_id, member_stay_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(observationId, person, stay)
  }
  const change: RosterChange = { joined: [], gone: [], changed: [] }
  const present = new Set<number>()

  for (const member of members) {
    const { pk: person, revised } = seenIdentity(context, accountKey, provider, member.id, member.name, {
      username: member.username,
      ...(member.isBot === undefined ? {} : { isBot: member.isBot }),
      marks: marksOf(member),
    })
    present.add(person)
    if (revised) change.changed.push(member.id)

    const open = orm
      .select({ pk: memberStays.id, joinedAt: memberStays.joinedAt, lastSeenAt: memberStays.lastSeenAt })
      .from(memberStays)
      .where(and(eq(memberStays.chatId, chatKey), eq(memberStays.identityId, person), isNull(memberStays.leftAt)))
      .get()
    const parsedJoin = member.joinedAt ? Date.parse(member.joinedAt) : Number.NaN
    const joinedAt = Number.isSafeInteger(parsedJoin) && parsedJoin >= 0 && parsedJoin <= observedAt ? parsedJoin : null
    const rejoined =
      open && joinedAt !== null && open.joinedAt !== null && joinedAt !== open.joinedAt && joinedAt > open.lastSeenAt
    if (rejoined) orm.update(memberStays).set({ leftAt: joinedAt }).where(eq(memberStays.id, open.pk)).run()
    if (open && !rejoined) {
      orm
        .update(memberStays)
        .set({ lastSeenAt: observedAt, role: member.role ?? null, joinedAt: joinedAt ?? open.joinedAt })
        .where(eq(memberStays.id, open.pk))
        .run()
      recordMember(person, open.pk)
      continue
    }
    const invitedBy = member.invitedBy ? identityPk(context, accountKey, provider, member.invitedBy, null) : null
    const inserted = orm
      .insert(memberStays)
      .values({
        chatId: chatKey,
        identityId: person,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        joinedAt,
        invitedByIdentityId: invitedBy,
        role: member.role ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ pk: memberStays.id })
      .get()
    if (inserted) recordMember(person, inserted.pk)
    change.joined.push(member.id)
  }

  if (complete) {
    const missing = orm
      .select({ pk: memberStays.id, person: memberStays.identityId, id: identities.externalId })
      .from(memberStays)
      .innerJoin(identities, eq(identities.id, memberStays.identityId))
      .where(and(eq(memberStays.chatId, chatKey), isNull(memberStays.leftAt)))
      .all()
      .filter(({ person }) => !present.has(person))
    for (const { pk, id } of missing) {
      orm.update(memberStays).set({ leftAt: observedAt }).where(eq(memberStays.id, pk)).run()
      change.gone.push(id)
    }
    orm.delete(chatMembers).where(eq(chatMembers.chatId, chatKey)).run()
    for (const person of present)
      orm.insert(chatMembers).values({ chatId: chatKey, identityId: person, createdAt: at }).run()
  }

  const day = new Date(at).toISOString().slice(0, 10)
  const count = {
    reportedCount: participants,
    listedCount: members.length,
    completeList: complete ? 1 : 0,
    createdAt: at,
  }
  orm
    .insert(memberCounts)
    .values({ chatId: chatKey, date: day, ...count })
    .onConflictDoUpdate({ target: [memberCounts.chatId, memberCounts.date], set: count })
    .run()
  return change
}

/** Every stay that was open at `since` or began after it, oldest first; all of them without `since`. */
export const memberStaysOf = ({ orm }: StoreContext, chatKey: number, since?: number): MemberStay[] =>
  orm
    .select({
      id: identities.externalId,
      name: identities.name,
      username: identities.username,
      firstSeenAt: memberStays.firstSeenAt,
      lastSeenAt: memberStays.lastSeenAt,
      joinedAt: memberStays.joinedAt,
      invitedBy: sql<
        string | null
      >`(SELECT external_id FROM identities i WHERE i.id = ${memberStays.invitedByIdentityId})`,
      role: memberStays.role,
      goneAt: memberStays.leftAt,
    })
    .from(memberStays)
    .innerJoin(identities, eq(identities.id, memberStays.identityId))
    .where(
      and(
        eq(memberStays.chatId, chatKey),
        since === undefined ? undefined : or(isNull(memberStays.leftAt), gte(memberStays.leftAt, since)),
      ),
    )
    .orderBy(asc(memberStays.firstSeenAt), asc(memberStays.id))
    .all()
    .map((row) => ({
      ...row,
      firstSeenAt: iso(row.firstSeenAt) as string,
      lastSeenAt: iso(row.lastSeenAt) as string,
      joinedAt: iso(row.joinedAt),
      goneAt: iso(row.goneAt),
    }))

export const memberCountsOf = ({ orm }: StoreContext, chatKey: number, since?: string): MemberCount[] =>
  orm
    .select({
      day: memberCounts.date,
      participants: memberCounts.reportedCount,
      listed: memberCounts.listedCount,
      complete: memberCounts.completeList,
    })
    .from(memberCounts)
    .where(and(eq(memberCounts.chatId, chatKey), since === undefined ? undefined : gte(memberCounts.date, since)))
    .orderBy(asc(memberCounts.date))
    .all()
    .map((row) => ({ ...row, complete: row.complete === 1 }))

/** Profiles of the chat's members, every revision, oldest first. */
export const profileRevisionsOf = ({ orm }: StoreContext, chatKey: number, since?: number): ProfileRevision[] => {
  const people = orm
    .selectDistinct({ pk: memberStays.identityId })
    .from(memberStays)
    .where(eq(memberStays.chatId, chatKey))
  return orm
    .select({
      id: identities.externalId,
      name: identityRevisions.name,
      username: identityRevisions.username,
      description: identityRevisions.description,
      marks: identityRevisions.marks,
      capturedAt: identityRevisions.createdAt,
    })
    .from(identityRevisions)
    .innerJoin(identities, eq(identities.id, identityRevisions.identityId))
    .where(
      and(
        inArray(identityRevisions.identityId, people),
        since === undefined ? undefined : gte(identityRevisions.createdAt, since),
      ),
    )
    .orderBy(asc(identityRevisions.createdAt), asc(identityRevisions.id))
    .all()
    .map((row) => ({
      ...row,
      marks: row.marks ? (JSON.parse(row.marks) as Record<string, boolean>) : {},
      capturedAt: iso(row.capturedAt) as string,
    }))
}

export const setTracked = ({ orm, now }: StoreContext, chatKey: number, tracked: boolean): void => {
  orm
    .update(chats)
    .set({ membersTrackedAt: tracked ? sql`coalesce(${chats.membersTrackedAt}, ${now()})` : null })
    .where(eq(chats.id, chatKey))
    .run()
}

export const trackedChats = (context: StoreContext, accountKey: number): TrackedChat[] =>
  context.orm
    .select({ pk: chats.id, chatId: chats.externalId, title: chats.title, trackedAt: chats.membersTrackedAt })
    .from(chats)
    .where(and(eq(chats.accountId, accountKey), isNotNull(chats.membersTrackedAt)))
    .orderBy(asc(chats.membersTrackedAt))
    .all()
    .map(({ pk, chatId, title, trackedAt }) => ({
      chatId,
      title,
      trackedAt: iso(trackedAt) as string,
      lastCount: memberCountsOf(context, pk).at(-1) ?? null,
    }))
