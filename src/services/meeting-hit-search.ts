import { CliError } from "@wirecat/cli-base"
import type { MeetingHitSearchRequest } from "../meetings/index.js"
import type { VocabularyKind } from "../store/index.js"
import type { MessageStore } from "../store/store.js"

export type { MeetingHitSearchRequest } from "../meetings/index.js"

/** Each batch commits on its own, so a search cut short by its deadline keeps the progress it made. */
export const refreshMeetingIndex = async (
  meetings: Pick<MessageStore["meetings"], "indexSearch">,
  accountId: number,
  signal?: AbortSignal,
): Promise<void> => {
  let before = Number.POSITIVE_INFINITY
  for (;;) {
    signal?.throwIfAborted()
    const { indexed, remaining } = await meetings.indexSearch({
      accountId,
      limit: 1000,
      maxReadBytes: 64 * 1024 ** 2,
      signal,
    })
    if (remaining === 0 || indexed === 0 || remaining >= before) return
    before = remaining
  }
}

/** Name resolution changes selection only; it never assigns projects or labels from transcript words. */
export const resolveMeetingSelection = async (
  store: { knowledge?: MessageStore["knowledge"] },
  request: MeetingHitSearchRequest,
) => {
  const { project, tag, topic, ...input } = request
  input.signal?.throwIfAborted()
  if (
    (project !== undefined && input.projectId !== undefined) ||
    [tag, topic].filter((value) => value !== undefined).length + Number(input.tagId !== undefined) > 1
  )
    throw new CliError("validation_error", "choose one project selector and one tag or topic selector")
  const selection: { kind: VocabularyKind; id: number; name: string; by: "explicit-link" }[] = []
  const knowledge = store.knowledge
  if (!knowledge && [project, tag, topic].some((value) => value !== undefined))
    throw new CliError("configuration_error", "this store cannot resolve project, tag or topic names")
  for (const [kind, name] of [
    ["project", project],
    ["tag", tag],
    ["topic", topic],
  ] as const) {
    if (name === undefined) continue
    if (!knowledge) continue
    const found = await knowledge.resolveVocabulary(name, { kind, signal: input.signal })
    input.signal?.throwIfAborted()
    if (found.ambiguous || found.matches.length !== 1)
      throw new CliError(
        found.matches.length ? "validation_error" : "not_found",
        `the ${kind} name needs one canonical record`,
        {
          candidates: found.matches.map((entry) => ({ kind: entry.kind, id: entry.id, name: entry.name })),
        },
      )
    const entry = found.matches[0]
    const id = Number(entry?.id)
    if (!entry || entry.kind !== kind || !Number.isSafeInteger(id) || id < 1)
      throw new CliError("invalid_response", "vocabulary resolution returned an invalid canonical record")
    if (kind === "project") input.projectId = id
    else input.tagId = id
    selection.push({ kind, id, name: entry.name, by: "explicit-link" })
  }
  return { input, selection }
}

export const searchMeetingHits = async (
  store: Pick<MessageStore, "meetings"> & { knowledge?: MessageStore["knowledge"] },
  query: string,
  request: MeetingHitSearchRequest,
  options: { refreshIndex?: boolean } = {},
) => {
  const { input, selection } = await resolveMeetingSelection(store, request)
  if (options.refreshIndex !== false) await refreshMeetingIndex(store.meetings, input.accountId, input.signal)
  const result = await store.meetings.searchHits(query, input)
  input.signal?.throwIfAborted()
  return { ...result, selection }
}
