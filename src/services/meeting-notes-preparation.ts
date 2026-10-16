import { CliError } from "@wirecat/cli-base"
import type { MeetingPreparationNote } from "../meetings/index.js"
import type { MeetingPreparation, MeetingPreparationPorts } from "./meeting-preparation-types.js"
import { preparationCancelled, type preparationRequest } from "./meeting-preparation-validation.js"

const invalid = (): never => {
  throw new CliError("invalid_response", "Preparation notes returned an invalid selection")
}
const noteOf = (note: MeetingPreparationNote, before: number, anchors: ReadonlySet<string>): MeetingPreparationNote => {
  if (
    !note ||
    typeof note.ref !== "string" ||
    !/^note:[1-9]\d*$/.test(note.ref) ||
    (note.title !== null && typeof note.title !== "string") ||
    typeof note.text !== "string" ||
    !note.text.trim() ||
    !Number.isSafeInteger(note.revision) ||
    note.revision < 1 ||
    !Number.isSafeInteger(note.updatedAt) ||
    Math.abs(note.updatedAt) > 8640000000000000 ||
    note.updatedAt > before ||
    (note.person !== null && (typeof note.person !== "string" || !/^person:[1-9]\d*$/.test(note.person))) ||
    (note.project !== null && (typeof note.project !== "string" || !/^project:[1-9]\d*$/.test(note.project))) ||
    (note.meeting !== undefined && note.meeting !== null && !anchors.has(note.meeting)) ||
    !(note.person || note.project || note.meeting)
  )
    return invalid()
  return {
    ref: note.ref,
    title: note.title,
    text: note.text,
    revision: note.revision,
    updatedAt: note.updatedAt,
    person: note.person,
    project: note.project,
    ...(note.meeting !== undefined ? { meeting: note.meeting } : {}),
  }
}

export const appendNotesPreparation = async (
  store: MeetingPreparationPorts["meetings"],
  result: MeetingPreparation,
  input: ReturnType<typeof preparationRequest>,
) => {
  if (!store.preparationNotes || !result.series || !result.items.length || result.coverage.outputLimited) return
  const limit = Math.min(input.contextLimit, 20)
  const page = await store.preparationNotes({
    accountId: result.accountId,
    seriesId: result.series.id,
    anchorIds: result.items.map((item) => item.meeting.id),
    after: input.historyAfter,
    before: input.after,
    limit,
    maxReadBytes: input.maxReadBytes,
    signal: input.signal,
  })
  preparationCancelled(input.signal)
  if (!page || !Array.isArray(page.items) || page.items.length > limit || typeof page.hasMore !== "boolean")
    return invalid()
  const selection = page.selection === undefined ? "owner-written-global-person/project-notes" : page.selection
  if (!["owner-written-global-person/project-notes", "owner-written-meeting/person/project-notes"].includes(selection))
    return invalid()
  const anchors = new Set(result.items.map((item) => item.reference))
  const items = page.items.map((note) => noteOf(note, input.after, anchors))
  if (items.some((note) => note.meeting) && selection !== "owner-written-meeting/person/project-notes") return invalid()
  if (new Set(items.map((note) => note.ref)).size !== items.length) return invalid()
  if (
    items.reduce((total, note) => total + Buffer.byteLength((note.title ?? "") + note.text, "utf8"), 0) >
    input.maxReadBytes
  )
    return invalid()
  const notes: NonNullable<MeetingPreparation["notes"]> = {
    anchors: result.items.map((item) => item.reference),
    items: [],
    selection,
    coverage: {
      hasMore: page.hasMore,
      outputLimited: false,
      sourceEvidence: "not-revalidated",
      otherSources: "not-queried",
    },
  }
  result.notes = notes
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8")
  if (size() > input.bytes) {
    delete result.notes
    result.coverage.outputLimited = true
    return
  }
  for (const note of items) {
    notes.items.push(note)
    if (size() > input.bytes) {
      notes.items.pop()
      notes.coverage.outputLimited = result.coverage.outputLimited = true
      break
    }
  }
}
