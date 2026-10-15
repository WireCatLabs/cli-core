import { CliError } from "@wirecat/cli-base"
import type { MeetingPreparationFact } from "../meetings/index.js"
import type { MeetingPreparation, MeetingPreparationPorts } from "./meeting-preparation-types.js"
import { preparationCancelled, type preparationRequest } from "./meeting-preparation-validation.js"

const invalid = (): never => {
  throw new CliError("invalid_response", "Preparation knowledge returned an invalid selection")
}
const factOf = (fact: MeetingPreparationFact, before: number): MeetingPreparationFact => {
  if (
    !fact ||
    typeof fact.ref !== "string" ||
    !/^fact:[1-9]\d*$/.test(fact.ref) ||
    !["fact", "statement", "question", "decision", "promise"].includes(fact.type) ||
    typeof fact.statement !== "string" ||
    !fact.statement.trim() ||
    (fact.subject !== null &&
      (typeof fact.subject !== "string" || !/^(person|project):[1-9]\d*$/.test(fact.subject))) ||
    (fact.project !== null && (typeof fact.project !== "string" || !/^project:[1-9]\d*$/.test(fact.project))) ||
    !Number.isSafeInteger(fact.updatedAt) ||
    Math.abs(fact.updatedAt) > 8640000000000000 ||
    fact.updatedAt > before ||
    typeof fact.sharedPerson !== "boolean" ||
    typeof fact.sharedProject !== "boolean" ||
    !(fact.sharedPerson || fact.sharedProject) ||
    (fact.sharedPerson && !fact.subject?.startsWith("person:")) ||
    (fact.sharedProject && !fact.project && !fact.subject?.startsWith("project:"))
  )
    return invalid()
  return {
    ref: fact.ref,
    type: fact.type,
    statement: fact.statement,
    subject: fact.subject,
    project: fact.project,
    updatedAt: fact.updatedAt,
    sharedPerson: fact.sharedPerson,
    sharedProject: fact.sharedProject,
  }
}

/** Stored meeting evidence keeps priority over optional accepted knowledge. */
export const appendKnowledgePreparation = async (
  store: MeetingPreparationPorts["meetings"],
  result: MeetingPreparation,
  input: ReturnType<typeof preparationRequest>,
) => {
  if (!store.preparationKnowledge || !result.series || !result.items.length || result.coverage.outputLimited) return
  const limit = Math.min(input.contextLimit, 20)
  const page = await store.preparationKnowledge({
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
  const items = page.items.map((fact) => factOf(fact, input.after))
  if (new Set(items.map((fact) => fact.ref)).size !== items.length) return invalid()
  const readBytes = items.reduce((total, fact) => total + Buffer.byteLength(fact.statement + fact.type, "utf8"), 0)
  if (readBytes > input.maxReadBytes) return invalid()
  const knowledge: NonNullable<MeetingPreparation["knowledge"]> = {
    anchors: result.items.map((item) => item.reference),
    items: [],
    hasMore: page.hasMore,
    outputLimited: false,
    selection: "accepted-global-person/project-facts",
    factEvidence: "not-revalidated",
    otherSources: "not-queried",
  }
  result.knowledge = knowledge
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8")
  if (size() > input.bytes) {
    delete result.knowledge
    result.coverage.outputLimited = true
    return
  }
  for (const fact of items) {
    knowledge.items.push(fact)
    if (size() > input.bytes) {
      knowledge.items.pop()
      knowledge.outputLimited = result.coverage.outputLimited = true
      break
    }
  }
}
