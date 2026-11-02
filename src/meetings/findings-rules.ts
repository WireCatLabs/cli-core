import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { FACT_TYPES, type Payment, validatePayment } from "./payment.js"
import { meetingTimestamp } from "./timestamp.js"

const TASK_TYPES = ["bug", "feature", "chore"] as const
export interface FindingEvidence {
  reference: string
  fingerprint: string
}
interface FindingBase {
  id: string
  /** Every task finding has one; a fact finding may have none when its rules allow it. */
  project?: string
  /** Who or what a fact is about: `person:`, `organization:`, `task:` or `project:`. */
  subject?: string
  evidence: FindingEvidence[]
}
export interface FactFinding extends FindingBase {
  kind: "fact"
  type: (typeof FACT_TYPES)[number]
  statement: string
}
/**
 * A payment an agent read. Confirming it writes money through `store.finance`, never a fact: a paid one a `payments`
 * row, an expected one an invoice; a paid one that supersedes an invoice settles it, a cancelled one voids it.
 */
export interface PaymentFinding extends FindingBase {
  kind: "payment"
  /** The full sentence, kept as the proposal's reason; without one, the payment's title. */
  statement?: string
  payment: Payment
  /** The `invoice:` of the expected payment this one settles (paid) or voids (cancelled). */
  supersedes?: string
}
export interface TaskFinding extends FindingBase {
  kind: "task"
  type: (typeof TASK_TYPES)[number]
  title: string
  reason: string
  commitment: "explicit" | "inferred"
  dueAt?: string
  dueEvidence?: string[]
  assignee?: string
  assigneeEvidence?: string[]
}
export type Finding = FactFinding | TaskFinding | PaymentFinding
export interface FindingsInput {
  schemaVersion: 1
  key: string
  extractor: string
  findings: Finding[]
}
export interface FindingOutcome {
  id: string
  fingerprint: string
  status: "accepted" | "rejected"
  reference: string | null
  reused: boolean
}
export interface FindingsReceipt {
  previewFingerprint: string
  accepted: string[]
  items: FindingOutcome[]
}
const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}
const text = (value: unknown, limit: number): string => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > limit)
    return invalid(`finding text must contain 1–${limit} characters without NUL`)
  return value.trim()
}
export const findingHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const fields = (value: object, allowed: string[], noun: string) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`unknown ${noun} field`)
}
/** What differs between findings kinds: their wording and what one cited reference must look like. */
export interface FindingsRules {
  /** "meeting findings" */
  plural: string
  /** "meeting finding" */
  singular: string
  /** "cue" */
  cited: string
  reference: (raw: string) => string
  /** A fact finding may name no project, and any finding may name a subject. */
  anySubject?: boolean
  /** Payment findings are staged on a project's evidence, not from a meeting. */
  payments?: boolean
}

const SUBJECT = /^(person|organization|project):[1-9]\d*$|^task:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export const validateFindings = (input: FindingsInput, rules: FindingsRules): FindingsInput => {
  if (!input || typeof input !== "object" || Buffer.byteLength(JSON.stringify(input), "utf8") > 65536)
    return invalid(`${rules.plural} take at most 65536 UTF-8 bytes`)
  fields(input, ["schemaVersion", "key", "extractor", "findings"], rules.singular)
  if (
    input.schemaVersion !== 1 ||
    !Array.isArray(input.findings) ||
    input.findings.length < 1 ||
    input.findings.length > 16
  )
    return invalid(`schemaVersion 1 takes 1–16 ${rules.plural}`)
  const key = text(input.key, 64)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(key))
    return invalid("a findings key uses letters, digits, dot, colon, underscore or hyphen")
  const ids = new Set<string>()
  const findings = input.findings.map((finding): Finding => {
    if (!finding || typeof finding !== "object") return invalid("a finding is an object")
    const id = text(finding.id, 64)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id) || ids.has(id))
      return invalid("finding IDs must be unique simple keys")
    ids.add(id)
    const project = finding.project === undefined && rules.anySubject ? undefined : text(finding.project, 64)
    if (project !== undefined && !/^project:[1-9]\d*$/.test(project))
      return invalid("a finding names a project reference")
    if (finding.subject !== undefined && (!rules.anySubject || !SUBJECT.test(text(finding.subject, 80))))
      return invalid("a finding's subject is a person:, organization:, task: or project: reference")
    if (finding.kind === "task" && project === undefined)
      return invalid("a task finding names the project the task goes in")
    if (!Array.isArray(finding.evidence) || finding.evidence.length < 1 || finding.evidence.length > 8)
      return invalid(`a finding requires 1–8 cited ${rules.cited}s`)
    const evidence = finding.evidence
      .map((item) => {
        if (!item || typeof item !== "object") return invalid("finding evidence is a reference and fingerprint")
        fields(item, ["reference", "fingerprint"], rules.singular)
        if (typeof item.reference !== "string" || typeof item.fingerprint !== "string")
          return invalid("evidence requires a reference and fingerprint")
        const reference = rules.reference(item.reference)
        if (!/^[a-f0-9]{64}$/.test(item.fingerprint))
          return invalid(`finding evidence requires exact ${rules.cited} references and fingerprints`)
        return { reference, fingerprint: item.fingerprint }
      })
      .sort((a, b) => a.reference.localeCompare(b.reference))
    if (new Set(evidence.map((item) => item.reference)).size !== evidence.length)
      return invalid(`duplicate evidence ${rules.cited}`)
    const base = {
      id,
      ...(project === undefined ? {} : { project }),
      ...(finding.subject === undefined ? {} : { subject: finding.subject }),
      evidence,
    }
    if (finding.kind === "fact") {
      fields(finding, ["id", "project", "subject", "evidence", "kind", "type", "statement"], rules.singular)
      if ((finding.type as string) === "payment")
        return invalid("a payment is a finding of kind payment; money is a payments row, not a fact")
      if (!FACT_TYPES.includes(finding.type)) return invalid("unknown fact finding type")
      return { ...base, kind: "fact", type: finding.type, statement: text(finding.statement, 2000) }
    }
    if (finding.kind === "payment" && rules.payments) {
      fields(
        finding,
        ["id", "project", "subject", "evidence", "kind", "statement", "payment", "supersedes"],
        rules.singular,
      )
      if (finding.supersedes !== undefined && !/^invoice:[1-9]\d*$/.test(String(finding.supersedes)))
        return invalid("a payment finding supersedes an invoice: reference, the expected payment it settles or voids")
      const payment = validatePayment(finding.payment)
      if (payment.state === "expected" && finding.supersedes !== undefined)
        return invalid("an expected payment supersedes nothing; a paid or cancelled one supersedes its invoice")
      if (payment.state === "cancelled" && finding.supersedes === undefined)
        return invalid("a cancelled payment names the invoice: it cancels in supersedes")
      if (payment.state === "expected" && !/^(person|organization):/.test(payment.counterparty ?? ""))
        return invalid(
          "an expected payment becomes an invoice, which names its counterparty as a person: or organization:",
        )
      return {
        ...base,
        kind: "payment",
        ...(finding.statement === undefined ? {} : { statement: text(finding.statement, 2000) }),
        payment,
        ...(finding.supersedes === undefined ? {} : { supersedes: finding.supersedes }),
      }
    }
    if (finding.kind !== "task") return invalid(`a finding is a fact${rules.payments ? ", payment" : ""} or task`)
    fields(
      finding,
      [
        "id",
        "project",
        "evidence",
        "kind",
        "type",
        "title",
        "reason",
        "commitment",
        "dueAt",
        "dueEvidence",
        "assignee",
        "assigneeEvidence",
      ],
      rules.singular,
    )
    if (!TASK_TYPES.includes(finding.type)) return invalid("a task finding type is bug, chore or feature")
    if (!["explicit", "inferred"].includes(finding.commitment))
      return invalid("task commitment must be explicit or inferred")
    const support = (value: unknown): string[] => {
      if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > 8 ||
        value.some((ref) => typeof ref !== "string" || !evidence.some((item) => item.reference === ref))
      )
        return invalid("date and assignee support must cite the finding's evidence")
      return [...new Set(value as string[])].sort()
    }
    if (
      (finding.dueAt === undefined) !== (finding.dueEvidence === undefined) ||
      (finding.assignee === undefined) !== (finding.assigneeEvidence === undefined)
    )
      return invalid("optional dates and assignees require their supporting evidence")
    if (
      finding.assignee !== undefined &&
      (typeof finding.assignee !== "string" || !/^person:[1-9]\d*$/.test(finding.assignee))
    )
      return invalid("an assignee must be a person reference")
    return {
      ...base,
      kind: "task",
      type: finding.type,
      title: text(finding.title, 300),
      reason: text(finding.reason, 2000),
      commitment: finding.commitment,
      ...(finding.dueAt === undefined
        ? {}
        : { dueAt: meetingTimestamp(finding.dueAt, "finding due date"), dueEvidence: support(finding.dueEvidence) }),
      ...(finding.assignee === undefined
        ? {}
        : { assignee: finding.assignee, assigneeEvidence: support(finding.assigneeEvidence) }),
    }
  })
  return { schemaVersion: 1, key, extractor: text(input.extractor, 200), findings }
}
export const findingFingerprint = ({ id: _id, ...finding }: Finding): string => findingHash(finding)
