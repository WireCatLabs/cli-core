import { CliError } from "@wirecat/cli-core"
import type { MeetingSearchIndexStore } from "@wirecat/cli-meetings"
import { NORMALIZER_VERSION, normalize } from "../normalize.js"
import { checkMeetingCancelled, meetingWriteSnapshot } from "./meeting-operation.js"
import { positiveReadInteger } from "./meeting-reads.js"
import {
  meetingCurrentIndexRows,
  meetingQueuedIndexRows,
  meetingStemmableText,
  meetingStemState,
  meetingStemStateName,
} from "./meeting-stem-state.js"
import { type INDEX_CODES, indexedText, meetingRowid } from "./meetings.js"
import type { StoreContext } from "./open.js"

export function meetingHitIndexOver({ database, now }: StoreContext): MeetingSearchIndexStore {
  return {
    async indexSearch(original) {
      const input = { ...original }
      checkMeetingCancelled(input.signal)
      positiveReadInteger(input.accountId, "accountId")
      const limit = input.limit ?? 100
      const maxReadBytes = input.maxReadBytes ?? 4 * 1024 ** 2
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new CliError("validation_error", "Meeting indexing limit must be from 1 through 1000")
      if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 64 * 1024 ** 2)
        throw new CliError("validation_error", "Meeting indexing byte limit must be from 1 through 67108864")
      return meetingWriteSnapshot(database, () => {
        checkMeetingCancelled(input.signal)
        if (!database.prepare("SELECT 1 FROM accounts WHERE id=?").get(input.accountId))
          throw new CliError("not_found", "Meeting index account not found")
        const state = meetingStemState(database, input.accountId)
        if (!state.stemmer)
          throw new CliError(
            "configuration_error",
            "Meeting stemmers are unknown; choose supported store stemmers before indexing",
          )
        const candidates = `WITH current AS (${meetingCurrentIndexRows}), queued AS (${meetingQueuedIndexRows}), candidates AS (SELECT * FROM current WHERE rid>? UNION SELECT * FROM queued)`
        const parameters = [input.accountId, input.accountId, input.accountId, input.accountId, state.through]
        const rows = database
          .prepare(`${candidates} SELECT * FROM candidates ORDER BY rid LIMIT ?`)
          .all(...parameters, limit)
        let bytes = 0
        for (const row of rows) {
          const size = Number(row.bytes)
          bytes += size
          if (!Number.isSafeInteger(size) || size < 0 || bytes > maxReadBytes)
            throw new CliError("validation_error", "Meeting indexing exceeds its stored text byte budget")
        }
        const remove = database.prepare("DELETE FROM meeting_words WHERE rowid=?")
        const removeStems = database.prepare("DELETE FROM meeting_stems WHERE rowid=?")
        const addStems = database.prepare("INSERT INTO meeting_stems(rowid,stems,scope) VALUES(?,?,?)")
        const add = database.prepare("INSERT INTO meeting_words(rowid,normalized_text,scope) VALUES(?,?,?)")
        const dequeue = database.prepare("DELETE FROM meeting_index_pending WHERE indexable_type=? AND id=?")
        for (const row of rows) {
          checkMeetingCancelled(input.signal)
          const kind = String(row.indexable_type) as keyof typeof INDEX_CODES
          const id = Number(row.id)
          remove.run(meetingRowid(kind, id))
          removeStems.run(meetingRowid(kind, id))
          if (Number(row.live) === 1) {
            let text: string
            try {
              text = indexedText(database, kind, id) ?? ""
            } catch {
              throw new CliError("invalid_response", "Stored meeting search text has invalid structured text")
            }
            const normalized = normalize(text)
            const stemmed = state.stemmer.indexText(meetingStemmableText(text))
            if (normalized) add.run(meetingRowid(kind, id), normalized, kind)
            if (stemmed) addStems.run(meetingRowid(kind, id), stemmed, kind)
          }
          dequeue.run(kind, id)
        }
        const advanced = rows.reduce((through, row) => Math.max(through, Number(row.rid)), state.through)
        const leftover = Number(
          database
            .prepare(`SELECT count(*) AS n FROM (${meetingCurrentIndexRows}) WHERE rid>?`)
            .get(input.accountId, input.accountId, input.accountId, advanced)?.n ?? 0,
        )
        const through = leftover === 0 ? Math.max(advanced, state.watermark) : advanced
        database
          .prepare(
            "INSERT INTO search_index_state(name,watermark,filled_through,terms_through,normalizer_version,built_at,analyzer) VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET watermark=excluded.watermark,filled_through=excluded.filled_through,normalizer_version=excluded.normalizer_version,built_at=excluded.built_at,analyzer=excluded.analyzer",
          )
          .run(
            meetingStemStateName(input.accountId),
            state.watermark,
            through,
            0,
            NORMALIZER_VERSION,
            leftover === 0 ? now() : null,
            state.identity,
          )
        const remaining = Number(
          database
            .prepare(`${candidates} SELECT count(*) AS n FROM candidates`)
            .get(input.accountId, input.accountId, input.accountId, input.accountId, through)?.n ?? 0,
        )
        checkMeetingCancelled(input.signal)
        return { indexed: rows.length, remaining }
      })
    },
  }
}
