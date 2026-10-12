import { CliError } from "@wirecat/cli-base"
import type { MeetingHitSearchRequest, MeetingSearchPage } from "./search-store.js"

export type MeetingHitSearchOptions = Omit<MeetingHitSearchRequest, "accountId">
export type MeetingHitSearch = (query: string, options: MeetingHitSearchOptions) => Promise<MeetingSearchPage>
export const validateMeetingHitSearch = (query: string, options: MeetingHitSearchOptions = {}) => {
  const integer = (value: number, low: number, high: number) =>
    Number.isSafeInteger(value) && value >= low && value <= high
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.includes("\0") ||
    new TextEncoder().encode(query).byteLength > 65536 ||
    !integer(options.limit ?? 100, 1, 1000) ||
    !integer(options.maxReadBytes ?? 4194304, 1, 67108864) ||
    [options.meetingId, options.participantIdentityId, options.personId, options.projectId, options.tagId].some(
      (value) => value !== undefined && !integer(value, 1, Number.MAX_SAFE_INTEGER),
    ) ||
    [options.since, options.until].some(
      (value) => value !== undefined && !integer(value, -8640000000000000, 8640000000000000),
    ) ||
    (options.since !== undefined && options.until !== undefined && options.since > options.until) ||
    (options.after !== undefined &&
      (typeof options.after !== "string" || !/^[A-Za-z0-9_-]{1,1000}$/.test(options.after)))
  )
    throw new CliError("validation_error", "invalid bounded meeting search query, cursor or limits")
  for (const name of [options.project, options.tag, options.topic])
    if (
      name !== undefined &&
      (typeof name !== "string" || !name.trim() || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name))
    )
      throw new CliError(
        "validation_error",
        "a meeting vocabulary name takes 1–200 characters without control characters",
      )
  if (
    (options.project !== undefined && options.projectId !== undefined) ||
    [options.tag, options.topic, options.tagId].filter((value) => value !== undefined).length > 1
  )
    throw new CliError("validation_error", "choose one project selector and one tag or topic selector")
}
