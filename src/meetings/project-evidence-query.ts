import { CliError } from "@wirecat/cli-base"
import { dateRange, defineQuery, type Predicate, parseLucene, queryError, validateQuery } from "@wirecat/cli-base/query"
import type { MeetingProjectDiscoveryOptions } from "./project-discovery.js"
import { validateMeetingHitSearch } from "./search-validation.js"

const ids = {
  meeting_id: "meetingId",
  identity_id: "participantIdentityId",
  person_id: "personId",
  tag_id: "tagId",
  event_id: "eventId",
  series_id: "meetingSeriesId",
} as const
const context = {
  command: "meetings projects evidence",
  guide: "https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md",
}

export const MEETING_PROJECT_EVIDENCE_QUERY = defineQuery({
  entity: "meeting_project_evidence",
  backend: "sql",
  fields: [
    ...Object.keys(ids).map((name) => ({
      name,
      type: "num" as const,
      operators: ["term" as const],
      example: `${name}:12`,
      placement: "and" as const,
      relation: "meetings selected by this stored ID; identity selects participants, not speakers",
    })),
    {
      name: "started_at",
      type: "time",
      operators: ["term", "phrase", "range"],
      example: "started_at:[2026-10-01 TO 2026-10-31]",
      placement: "and",
      relation: "the meeting start time in UTC",
    },
  ],
})

export interface MeetingProjectEvidenceRequest {
  query?: string
  limit?: number
  cursor?: string
  maxReadBytes?: number
  signal?: AbortSignal
}
const requestKeys = new Set(["query", "limit", "cursor", "maxReadBytes", "signal"])

/** Resolve relative dates once; the returned query is safe to repeat with a cursor. */
export const prepareMeetingProjectEvidence = (
  project: string,
  request: MeetingProjectEvidenceRequest = {},
  now = Date.now(),
) => {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !requestKeys.has(key)) ||
    typeof project !== "string" ||
    !project.trim() ||
    project.length > 200 ||
    /[\p{Cc}\p{Cf}]/u.test(project) ||
    (request.query !== undefined && typeof request.query !== "string")
  )
    throw new CliError("validation_error", "expected an existing project and bounded evidence arguments")
  if (
    (request.query !== undefined && new TextEncoder().encode(request.query).byteLength > 8192) ||
    [request.limit, request.maxReadBytes].some((value) => value !== undefined && typeof value !== "number")
  )
    throw new CliError("validation_error", "invalid project evidence query or budget")
  request.signal?.throwIfAborted()
  const options: Omit<MeetingProjectDiscoveryOptions, "accountId"> = {
    limit: request.limit ?? 100,
    maxReadBytes: request.maxReadBytes ?? 4194304,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }
  const terms = new Map<string, Predicate>()
  if (request.query?.trim()) {
    const ast = parseLucene(request.query, { defaultField: "none", ...context })
    validateQuery(ast, MEETING_PROJECT_EVIDENCE_QUERY, context)
    const add = (node: Predicate) => {
      if (terms.has(node.field)) queryError("query.unsupported-placement", node.span, "each field only once", context)
      terms.set(node.field, node)
    }
    if (ast.root.kind === "predicate") add(ast.root)
    else
      for (const clause of ast.root.clauses) {
        if (clause.occur !== "must" || clause.node.kind !== "predicate")
          queryError("query.unsupported-placement", clause.node.span, "field:value terms joined by AND", context)
        add(clause.node)
      }
  }
  const frozen: string[] = []
  for (const [field, key] of Object.entries(ids)) {
    const term = terms.get(field)
    if (!term) continue
    if (term.operator !== "term" || !/^[1-9]\d*$/.test(term.value) || !Number.isSafeInteger(Number(term.value)))
      queryError("query.unsupported-operator", term.span, "one positive safe integer ID", context)
    options[key] = Number(term.value)
    frozen.push(`${field}:${term.value}`)
  }
  const term = terms.get("started_at")
  if (term) {
    const range = dateRange(
      term.value,
      term.operator === "range" ? (term.upper ?? "*") : term.value,
      term.lower_inclusive !== false,
      term.upper_inclusive !== false,
      "UTC",
      term.span,
      now,
    )
    if (range.lower !== undefined) options.since = range.lower + (range.lower_inclusive ? 0 : 1)
    if (range.upper !== undefined) options.until = range.upper - (range.upper_inclusive ? 0 : 1)
    frozen.push(
      `started_at:[${options.since === undefined ? "*" : `"${new Date(options.since).toISOString()}"`} TO ${options.until === undefined ? "*" : `"${new Date(options.until).toISOString()}"`}]`,
    )
  }
  validateMeetingHitSearch(project, options)
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(options.cursor))
  )
    throw new CliError("validation_error", "invalid project evidence cursor")
  return { project: project.trim(), options, query: frozen.join(" AND ") }
}
