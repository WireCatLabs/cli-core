import { prepareMeetingProjectEvidence } from "../meetings/index.js"
import type { MeetingPreparation, MeetingPreparationPorts } from "./meeting-preparation-types.js"
import { preparationCancelled, type preparationRequest } from "./meeting-preparation-validation.js"
import { readMeetingProjectDiscovery } from "./meeting-project-discovery.js"

const PAGE_LIMIT = 4
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

export const appendProjectPreparation = async (
  ports: MeetingPreparationPorts["projectDiscovery"],
  result: MeetingPreparation,
  input: ReturnType<typeof preparationRequest>,
) => {
  if (input.project === undefined || !ports || result.coverage.outputLimited) return
  const prepared = prepareMeetingProjectEvidence(input.project, {
    query: `started_at:["${new Date(input.historyAfter).toISOString()}" TO "${new Date(input.after - 1).toISOString()}"]`,
    limit: Math.min(input.contextLimit, 20),
    maxReadBytes: input.maxReadBytes,
    signal: input.signal,
  })
  const section: NonNullable<MeetingPreparation["projectEvidence"]> = {
    project: prepared.project,
    query: prepared.query,
    pages: [],
    coverage: { pageLimit: PAGE_LIMIT, hasMore: true, outputLimited: false },
  }
  result.projectEvidence = section
  if (size(result) > input.bytes) {
    delete result.projectEvidence
    result.coverage.outputLimited = true
    return
  }
  let cursor: string | undefined
  for (let index = 0; index < PAGE_LIMIT; index++) {
    const page = await readMeetingProjectDiscovery(ports, prepared.project, {
      ...prepared.options,
      accountId: result.accountId,
      maxVocabularyReadBytes: input.maxReadBytes,
      ...(cursor === undefined ? {} : { cursor }),
    }).catch((error) => {
      preparationCancelled(input.signal)
      throw error
    })
    preparationCancelled(input.signal)
    section.pages.push(page)
    section.coverage.hasMore = page.hasMore
    if (size(result) > input.bytes) {
      section.pages.pop()
      section.coverage.hasMore = true
      section.coverage.outputLimited = result.coverage.outputLimited = true
      break
    }
    if (!page.hasMore) break
    cursor = page.nextCursor ?? undefined
  }
}
