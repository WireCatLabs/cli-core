export type { RetentionResult } from "../contracts/retention-types.js"

import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { calendarKey } from "../../domain/calendar.js"
import {
  RETENTION_TOLERANCE,
  type RetentionOptions,
  type RetentionStay,
  retentionCohorts,
  validateRetentionOptions,
} from "../../domain/retention.js"
import { chatCompleteness } from "./completeness.js"
import type { StoreContext } from "./open.js"

const iso = (at: number) => new Date(at).toISOString()
const week = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}
export const retentionQuery = (
  context: StoreContext,
  accountPk: number,
  chatPk: number,
  chatId: string,
  options: RetentionOptions,
  evidence?: { cohort: string; cursor?: string },
) => {
  validateRetentionOptions(options)
  if (options.cutoff > context.now()) throw new CliError("validation_error", "retention cutoff cannot be in the future")
  const { database } = context
  const count = Number(
    database
      .prepare("SELECT count(*) AS n FROM member_stays WHERE chat_id=? AND joined_at BETWEEN ? AND ?")
      .get(chatPk, options.since, options.until)?.n ?? 0,
  )
  if (count > 10_000)
    throw new CliError("validation_error", "retention exceeds 10000 stays — narrow the join period", {
      reason: "query.too-large",
      complete: false,
    })
  const dayOf = calendarKey(options.timezone, "day")
  const archive = chatCompleteness(context, accountPk, [chatId])[0]
  const raw = database
    .prepare(
      "SELECT s.id AS pk,i.external_id AS person,s.identity_id,s.joined_at,s.first_seen_at,s.last_seen_at,s.left_at FROM member_stays s JOIN identities i ON i.id=s.identity_id WHERE s.chat_id=? AND s.joined_at BETWEEN ? AND ? ORDER BY s.joined_at,s.id",
    )
    .all(chatPk, options.since, options.until)
  const observationStatement = database.prepare(
    `SELECT o.id,o.observed_at,o.complete,EXISTS(SELECT 1 FROM member_observation_members om WHERE om.member_observation_id=o.id AND om.member_stay_id=?) AS present FROM member_observations o WHERE o.chat_id=? AND o.observed_at BETWEEN ? AND ? ORDER BY o.observed_at,o.id LIMIT 1`,
  )
  const departureStatement = database.prepare(
    `SELECT o.observed_at FROM member_observations o WHERE o.chat_id=? AND o.complete=1 AND o.observed_at BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM member_observation_members om WHERE om.member_observation_id=o.id AND om.member_stay_id=?) ORDER BY o.observed_at,o.id LIMIT 1`,
  )
  const lastPositiveStatement = database.prepare(
    `SELECT max(o.observed_at) AS at FROM member_observations o JOIN member_observation_members om ON om.member_observation_id=o.id WHERE om.member_stay_id=? AND o.observed_at < ?`,
  )
  const activityStatement = database.prepare(
    `SELECT min(sent_at) AS at FROM messages WHERE chat_id=? AND sender_identity_id=? AND deleted_at IS NULL AND sent_at >= ? AND sent_at < ?`,
  )
  const stays: RetentionStay[] = raw.map((row) => {
    const joinedAt = Number(row.joined_at),
      pk = Number(row.pk),
      end = joinedAt + options.within
    const day = dayOf(joinedAt),
      cohort = options.by === "week" ? week(day) : day
    const absence = departureStatement.get(chatPk, Math.max(joinedAt, Number(row.first_seen_at)), options.cutoff, pk)
    const upper = absence ? Number(absence.observed_at) : null
    const positive = lastPositiveStatement.get(pk, upper ?? options.cutoff + 1)
    const lower = positive?.at === null || positive?.at === undefined ? null : Number(positive.at)
    const activityEnd = Math.min(end, options.cutoff + 1, upper ?? Number.POSITIVE_INFINITY)
    const first = activityStatement.get(chatPk, Number(row.identity_id), joinedAt, activityEnd)?.at
    const covered =
      archive?.state === "complete" &&
      archive.fetchedAt !== null &&
      Date.parse(archive.fetchedAt) >= end &&
      end <= options.cutoff
    return {
      stay: pk,
      person: String(row.person),
      joinedAt: iso(joinedAt),
      cohort,
      checkpoints: options.checkpoints.map((checkpoint) => {
        const target = joinedAt + checkpoint
        if (target > options.cutoff)
          return {
            checkpoint,
            targetAt: iso(target),
            state: "pending",
            observedAt: null,
            lagMilliseconds: null,
            complete: null,
          }
        const read = observationStatement.get(
          pk,
          chatPk,
          target,
          Math.min(target + RETENTION_TOLERANCE, options.cutoff),
        )
        return {
          checkpoint,
          targetAt: iso(target),
          state: !read
            ? "unknown"
            : Number(read.present) === 1
              ? "present"
              : Number(read.complete) === 1
                ? "absent"
                : "unknown",
          observedAt: read ? iso(Number(read.observed_at)) : null,
          lagMilliseconds: read ? Number(read.observed_at) - target : null,
          complete: read ? Number(read.complete) === 1 : null,
        }
      }),
      activity: {
        state:
          first !== null && first !== undefined
            ? "observed-message"
            : end > options.cutoff
              ? "pending"
              : "no-observed-message",
        firstMessageAt: first === null || first === undefined ? null : iso(Number(first)),
        windowEnd: iso(end),
        archiveCovered: covered === true,
      },
      departure: {
        after: lower === null ? null : iso(lower),
        atOrBefore: upper === null ? null : iso(upper),
        early:
          upper !== null && upper <= end
            ? "observed"
            : lower !== null && lower >= end
              ? "not-observed"
              : end > options.cutoff
                ? "pending"
                : "unknown",
      },
    }
  })
  const unknownJoin = Number(
    database
      .prepare(
        "SELECT count(*) AS n FROM member_stays WHERE chat_id=? AND joined_at IS NULL AND first_seen_at BETWEEN ? AND ?",
      )
      .get(chatPk, options.since, options.until)?.n ?? 0,
  )
  const { limit: _limit, ...fixedOptions } = options
  const serialized = JSON.stringify({ options: fixedOptions, stays, unknownJoin, archive })
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
    throw new CliError("validation_error", "retention fingerprint exceeds 8 MiB — narrow the join period", {
      reason: "query.too-large",
      complete: false,
    })
  const fingerprint = createHash("sha256").update(serialized).digest("hex")
  const cohorts = retentionCohorts(stays, options)
  const selected = evidence ? stays.filter((stay) => stay.cohort === evidence.cohort) : stays
  let offset = 0
  if (evidence?.cursor) {
    try {
      if (evidence.cursor.length > 4096) throw new Error("oversized cursor")
      const cursor = JSON.parse(Buffer.from(evidence.cursor, "base64url").toString()) as {
        offset: number
        fingerprint: string
        cohort: string
      }
      if (
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > selected.length ||
        cursor.fingerprint !== fingerprint ||
        cursor.cohort !== evidence.cohort
      )
        throw new Error("changed selection")
      offset = cursor.offset
    } catch {
      throw new CliError("validation_error", "retention evidence changed or cursor is invalid — restart the report", {
        reason: "selection.changed",
      })
    }
  }
  const page: RetentionStay[] = []
  let bytes = 2
  for (const stay of selected.slice(offset, offset + options.limit)) {
    const size = Buffer.byteLength(JSON.stringify(stay)) + 1
    if (bytes + size > 64 * 1024) break
    bytes += size
    page.push(stay)
  }
  const next = offset + page.length
  const nextCursor =
    next < selected.length
      ? Buffer.from(JSON.stringify({ offset: next, fingerprint, cohort: evidence?.cohort ?? null })).toString(
          "base64url",
        )
      : null
  return {
    chatId,
    cutoff: iso(options.cutoff),
    options,
    items: cohorts.slice(0, options.limit),
    total: cohorts.length,
    included: Math.min(cohorts.length, options.limit),
    hasMore: cohorts.length > options.limit,
    unknownJoin,
    eligibleStays: stays.length,
    fingerprint,
    evidence: page,
    evidenceTotal: selected.length,
    nextCursor,
    byteLimit: 64 * 1024,
    quality: {
      membership: "observed_checkpoints" as const,
      toleranceMilliseconds: RETENTION_TOLERANCE,
      archive: archive ?? null,
      continuousSurvival: false,
      groupSilentRate: null,
    },
  }
}
