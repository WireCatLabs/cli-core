import { CliError } from "@wirecat/cli-base"
import type { MeetingPreparationItem } from "../entities/meeting-preparation.js"
import type { MeetingCommunications } from "../services/meeting-communications-types.js"

export const mapPreparationCommunications = (section: MeetingCommunications) => ({
  ...section,
  window: {
    after: new Date(section.window.after).toISOString(),
    before: new Date(section.window.before).toISOString(),
  },
  sources: section.sources.map((source) => ({
    ...source,
    source: { ...source.source, accountId: String(source.source.accountId) },
  })),
  items: section.items.map((item) => ({
    ...item,
    at: new Date(item.at).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  })),
})

export const trimPreparationCommunication = (item: MeetingPreparationItem) => {
  const removed = item.communications?.items.pop()
  if (!removed || !item.communications) return
  const source = item.communications.sources.find((s) => s.selection_id === removed.selection_id)
  if (!source) throw new CliError("invalid_response", "Communication excerpt has no selected source")
  source.output_limited = source.restart_required = item.coverage.output_limited = true
  source.next_cursor = null
}

export const communicationOptions = (options: Record<string, unknown>) => {
  const values = options.contextSource as string[] | undefined
  if (
    !values?.length &&
    ![options.contextQuery, options.contextSinceTime, options.contextBeforeTime].some((v) => v !== undefined)
  )
    return undefined
  return {
    sources: values?.map((value) => {
      const [id, cursor, ...rest] = value.split("=")
      if (rest.length || cursor === "") throw new CliError("validation_error", "context-source needs ID or ID=cursor")
      return { id, ...(cursor === undefined ? {} : { cursor }) }
    }),
    query: options.contextQuery,
    after: options.contextSinceTime,
    before: options.contextBeforeTime,
  }
}
