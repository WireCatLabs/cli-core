import { CliError } from "@wirecat/cli-base"
import { MEMORY_KINDS, MEMORY_SCOPES } from "../domain/knowledge.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import { parseReference } from "../domain/references.js"
import {
  type FactFinding,
  type FindingEvidence,
  type FindingsRules,
  findingFields,
  findingHash,
  findingId,
  findingText,
  meetingTimestamp,
  type TaskFinding,
  validateBatch,
  validateFinding,
  validEvidence,
} from "../meetings/index.js"

export { MAIL_FINDINGS_KIND } from "../store/mail-findings.js"
/** At most this many findings in one run's batch, and per sender in it. */
export const MAIL_FINDINGS_PER_RUN = 30
export const MAIL_FINDINGS_PER_SENDER = 5

interface Cited {
  id: string
  evidence: FindingEvidence[]
}
export type MailTaskFinding = TaskFinding
export type MailFactFinding = FactFinding
export interface MailTaskUpdateFinding extends Cited {
  kind: "task_update"
  task: string
  change: "close" | "due" | "detail"
  dueAt?: string
  detail?: string
  reason: string
}
export interface MailMemoryFinding extends Cited {
  kind: "memory"
  memoryKind: (typeof MEMORY_KINDS)[number]
  scope: (typeof MEMORY_SCOPES)[number]
  body: string
  subject?: string
  project?: string
}
/** Address → person, person → organization, or thread → project. */
export interface MailLinkFinding extends Cited {
  kind: "link"
  from: string
  to: string
  reason: string
}
export interface MailNewContactFinding extends Cited {
  kind: "new_contact"
  address: string
  name: string
  reason?: string
}
export type MailFinding =
  | MailTaskFinding
  | MailFactFinding
  | MailTaskUpdateFinding
  | MailMemoryFinding
  | MailLinkFinding
  | MailNewContactFinding

export interface MailFindingsInput {
  schemaVersion: 1
  /** `<holder>:<through_id>`: one batch per run of a holder over the mail it was given. */
  key: string
  extractor: string
  findings: MailFinding[]
}

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

const emailEvidence = (raw: string): string => {
  try {
    const locator = parseLocator(raw)
    if (locator.provider === "email") return formatLocator(locator)
  } catch {}
  return invalid("mail finding evidence is a msg:email/… reference")
}

const RULES: FindingsRules = {
  plural: "mail findings",
  singular: "mail finding",
  cited: "reference",
  reference: emailEvidence,
  anySubject: true,
  inboxTasks: true,
}

const typeOf = (reference: string): string | undefined => {
  try {
    const parsed = parseReference(reference)
    return parsed.type === "contact" || parsed.type === "chat" ? `${parsed.type}:${parsed.provider}` : parsed.type
  } catch {
    return undefined
  }
}

const LINKS: Record<string, string> = {
  "contact:email": "person",
  person: "organization",
  "chat:email": "project",
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/

const one = (raw: Record<string, unknown>, ids: Set<string>): MailFinding => {
  if (!raw || typeof raw !== "object") return invalid("a finding is an object")
  if (raw.kind === "task" || raw.kind === "fact") return validateFinding(raw as never, RULES, ids) as MailFinding
  const id = findingId(raw.id, ids)
  const evidence = validEvidence(raw.evidence, RULES)
  const reference = (value: unknown, pattern: RegExp, what: string) => {
    const text = findingText(value, 400)
    if (!pattern.test(text)) return invalid(`${what} is not a reference of the kind it takes: ${text}`)
    return text
  }
  switch (raw.kind) {
    case "task_update": {
      findingFields(raw, ["id", "kind", "task", "change", "dueAt", "detail", "reason", "evidence"], RULES.singular)
      const task = reference(raw.task, /^task:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "a task update's task")
      const change = raw.change
      if (change !== "close" && change !== "due" && change !== "detail")
        return invalid("a task update's change is close, due or detail")
      if ((change === "due") !== (raw.dueAt !== undefined)) return invalid("a due change, and only it, gives due_at")
      if ((change === "detail") !== (raw.detail !== undefined))
        return invalid("a detail change, and only it, gives detail")
      return {
        id,
        kind: "task_update",
        task,
        change,
        ...(raw.dueAt === undefined
          ? {}
          : { dueAt: meetingTimestamp(raw.dueAt as string, "a task update's due date") }),
        ...(raw.detail === undefined ? {} : { detail: findingText(raw.detail, 2000) }),
        reason: findingText(raw.reason, 2000),
        evidence,
      }
    }
    case "memory": {
      findingFields(
        raw,
        ["id", "kind", "memoryKind", "scope", "body", "subject", "project", "evidence"],
        RULES.singular,
      )
      if (!MEMORY_KINDS.includes(raw.memoryKind as never))
        return invalid(`a memory's memory_kind is ${MEMORY_KINDS.join(", ")}`)
      if (!MEMORY_SCOPES.includes(raw.scope as never)) return invalid("a memory's scope is personal or work")
      if (raw.subject === undefined && raw.project === undefined)
        return invalid("a memory is about a subject or a project")
      return {
        id,
        kind: "memory",
        memoryKind: raw.memoryKind as MailMemoryFinding["memoryKind"],
        scope: raw.scope as MailMemoryFinding["scope"],
        body: findingText(raw.body, 20_000),
        ...(raw.subject === undefined
          ? {}
          : { subject: reference(raw.subject, /^(person|organization|project):[1-9]\d*$/, "a memory's subject") }),
        ...(raw.project === undefined ? {} : { project: reference(raw.project, /^project:[1-9]\d*$/, "a project") }),
        evidence,
      }
    }
    case "link": {
      findingFields(raw, ["id", "kind", "from", "to", "reason", "evidence"], RULES.singular)
      const from = findingText(raw.from, 400)
      const to = findingText(raw.to, 80)
      const wanted = LINKS[typeOf(from) ?? ""]
      if (!wanted || typeOf(to) !== wanted || !/:[1-9]\d*$/.test(to))
        return invalid(
          "a link goes from contact:email/<address> to person:, person: to organization:, or chat:email/… to project:",
        )
      return { id, kind: "link", from, to, reason: findingText(raw.reason, 2000), evidence }
    }
    case "new_contact": {
      findingFields(raw, ["id", "kind", "address", "name", "reason", "evidence"], RULES.singular)
      const address = findingText(raw.address, 320).toLowerCase()
      if (!ADDRESS.test(address)) return invalid("a new contact's address is an email address")
      return {
        id,
        kind: "new_contact",
        address,
        name: findingText(raw.name, 200),
        ...(raw.reason === undefined ? {} : { reason: findingText(raw.reason, 2000) }),
        evidence,
      }
    }
    default:
      return invalid("a mail finding is a task, task_update, fact, memory, link or new_contact")
  }
}

/**
 * The shape of a mail findings batch: 1–30 findings, each citing 1–8 `msg:email/…` references with fingerprints.
 * What needs the store — the fingerprints, partial mail, the per-sender cap, the targets — the store checks.
 */
export const validateMailFindings = (input: MailFindingsInput): MailFindingsInput => {
  const batch = validateBatch(input, RULES, MAIL_FINDINGS_PER_RUN, one)
  if (!/^[a-z0-9][a-z0-9-]{0,39}:[1-9]\d*$/.test(batch.key))
    return invalid("a mail findings key is <holder>:<through_id>, such as mail-triage:9123456")
  return batch
}

export const mailFindingFingerprint = ({ id: _id, ...finding }: MailFinding): string => findingHash(finding)
