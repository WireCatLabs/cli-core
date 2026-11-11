import { CliError } from "@wirecat/cli-base"
import {
  type Finding,
  type FindingEvidence,
  type FindingOutcome,
  type FindingsInput,
  findingFields,
  findingHash,
} from "../../meetings/index.js"
import type { Decider } from "../decisions.js"
import { factOperationsOver } from "./facts.js"
import { linkEvidence } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { paymentEntriesOver } from "./payment-entries.js"
import { taskRowOf } from "./things.js"
import { workTaskOperationsOver } from "./work-tasks.js"

export interface FindingsAgent {
  bot: string
  model?: string
}

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

export const findingsAgent = (agent: FindingsAgent): FindingsAgent => {
  if (
    !agent ||
    typeof agent.bot !== "string" ||
    !agent.bot.trim() ||
    agent.bot.length > 200 ||
    agent.bot === "owner" ||
    (agent.model !== undefined && (typeof agent.model !== "string" || agent.model.length > 200))
  )
    return invalid("findings must name an agent author independently of their payload")
  return { bot: agent.bot, ...(agent.model === undefined ? {} : { model: agent.model }) }
}

/**
 * What the owner may change in a finding before it is decided: its words and the fields that only say what the agent
 * read. Evidence never changes, and neither does a meeting or evidence finding's project, which its evidence vouches
 * for.
 */
export const FINDING_EDITS: Readonly<Record<string, readonly string[]>> = {
  fact: ["statement", "type", "subject"],
  task: ["title", "type", "reason", "commitment", "dueAt", "dueEvidence", "assignee", "assigneeEvidence"],
  payment: ["statement"],
}

/** Each optional field a cleared field takes with it, so a cleared due date leaves no orphaned support. */
const CLEARS: Readonly<Record<string, string>> = { dueAt: "dueEvidence", assignee: "assigneeEvidence" }

/** The finding with the owner's changes; `null` clears an optional field. The kind's own validation runs after. */
export const editedFinding = <F extends { id: string; kind: string }>(
  finding: F,
  changes: Record<string, unknown>,
  editable: Readonly<Record<string, readonly string[]>>,
  noun: string,
): F => {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).length === 0)
    return invalid("an edit changes at least one field of the finding")
  findingFields(changes, [...(editable[finding.kind] ?? [])], noun, finding)
  const edited: Record<string, unknown> = { ...finding }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== null) {
      edited[key] = value
      continue
    }
    delete edited[key]
    const also = CLEARS[key]
    if (also) delete edited[also]
  }
  return edited as F
}

/**
 * The finding an owner's edit changes: only the owner edits, only a batch still waiting, at the fingerprint the owner
 * read, and only a finding this batch has not decided yet.
 */
export const findingToEdit = <F extends { id: string }>(
  batch: { status: string; fingerprint: string; input: { findings: readonly F[] }; decided: readonly FindingOutcome[] },
  finding: string,
  options: { fingerprint: string; by: Decider },
  stale: () => never,
): F => {
  if (options?.by !== "owner")
    throw new CliError("permission_error", "only the owner edits a finding before it is decided", {
      reason: "proposal.owner-only",
    })
  if (batch.status !== "proposed")
    throw new CliError("validation_error", "this findings batch was already reviewed; its findings stay as decided", {
      reason: "proposal.wrong-state",
    })
  if (typeof options.fingerprint !== "string" || options.fingerprint !== batch.fingerprint) return stale()
  const found = batch.input.findings.find((one) => one.id === finding)
  if (!found) throw new CliError("not_found", `no finding ${finding} in this batch`)
  if (batch.decided.some((one) => one.id === finding))
    throw new CliError("validation_error", `finding ${finding} was already decided`, { reason: "proposal.wrong-state" })
  return found
}

/** The findings a review has not decided yet. */
export const pendingOf = <I extends { findings: readonly { id: string }[] }>(
  input: I,
  decided: readonly FindingOutcome[] | undefined,
): I => ({ ...input, findings: input.findings.filter((one) => !decided?.some((done) => done.id === one.id)) })

/**
 * What meeting and evidence findings share: the project and assignee snapshot, earlier decisions on an unchanged
 * candidate, creating the accepted facts and tasks, and the receipt items. Each kind checks its own evidence,
 * including a reference it already saw for another finding.
 */
export const findingsCoreOver = (context: StoreContext, kind: string) => {
  const { database } = context
  const facts = factOperationsOver(context)
  const tasks = workTaskOperationsOver(context)
  const recordPayment = paymentEntriesOver(context)

  const cited = (
    input: FindingsInput,
    cite: (evidence: FindingEvidence, finding: Finding, projectId: string | null, seen: Map<string, unknown>) => void,
  ) => {
    const seen = new Map<string, unknown>()
    for (const finding of input.findings) {
      let projectId: string | null = null
      if (finding.project !== undefined) {
        const project = requiredThing(database, finding.project, "the project")
        if (project.type !== "project") return invalid("a finding needs an owner project")
        const projectRow = database
          .prepare(
            "SELECT id,key,name,description,type,scope,updated_at FROM projects WHERE id=? AND account_id IS NULL AND deleted_at IS NULL",
          )
          .get(project.id)
        if (!projectRow) throw new CliError("not_found", "the owner project is unavailable")
        seen.set(finding.project, projectRow)
        projectId = String(project.id)
      }
      if (finding.subject !== undefined)
        seen.set(finding.subject, requiredThing(database, finding.subject, "the subject"))
      if (finding.kind === "task" && finding.assignee) {
        const person = requiredThing(database, finding.assignee, "the assignee")
        if (person.type !== "person") return invalid("the assignee must be a stored person")
        const personRow = database.prepare("SELECT id,name,updated_at FROM persons WHERE id=?").get(person.id)
        if (!personRow) throw new CliError("not_found", "the assignee is unavailable")
        seen.set(finding.assignee, personRow)
      }
      for (const evidence of finding.evidence) cite(evidence, finding, projectId, seen)
    }
    return seen
  }
  const snapshot = (...args: Parameters<typeof cited>): string =>
    findingHash([...cited(...args)].sort(([a], [b]) => a.localeCompare(b)))
  /** The same snapshot, one hash per project, person and cited reference, so part of a batch can be checked alone. */
  const snapshotParts = (...args: Parameters<typeof cited>): Record<string, string> =>
    Object.fromEntries([...cited(...args)].map(([key, value]) => [key, findingHash(value)]))

  // A batch still partly pending keeps its decisions in the payload, so an unchanged finding another batch carries
  // is never created twice.
  const previous = (account: number | null, fingerprint: string, except?: string): FindingOutcome | undefined => {
    const row = database
      .prepare(
        "SELECT item FROM (SELECT p.id, substr(j.value,1,4096) AS item FROM proposed_actions p,json_each(p.result,'$.items') j WHERE p.account_id IS ? AND p.kind=? AND p.status='approved' AND json_extract(j.value,'$.fingerprint')=? " +
          "UNION ALL SELECT p.id, substr(j.value,1,4096) AS item FROM proposed_actions p,json_each(p.payload,'$.decided') j WHERE p.account_id IS ? AND p.kind=? AND p.status='proposed' AND p.id IS NOT ? AND json_extract(j.value,'$.fingerprint')=?) ORDER BY id LIMIT 1",
      )
      .get(account, kind, fingerprint, account, kind, except === undefined ? null : Number(except), fingerprint)
    return row ? (JSON.parse(String(row.item)) as FindingOutcome) : undefined
  }

  const create = (finding: Finding, agent: FindingsAgent, decidedBy: Decider): string => {
    const evidence = finding.evidence.map((item) => item.reference)
    // The quote goes into the evidence link, so a later source check knows which words the fact rests on.
    const quoted = finding.evidence.map((item) =>
      item.quote === undefined ? item.reference : { ref: item.reference, quote: item.quote },
    )
    if (finding.kind === "fact") {
      const fact = facts.add({
        type: finding.type,
        statement: finding.statement,
        ...(finding.project === undefined ? {} : { project: finding.project }),
        ...(finding.subject === undefined ? {} : { subject: finding.subject }),
        evidence: quoted,
        by: agent,
      })
      return facts.acceptChecked(fact.ref, decidedBy).ref
    }
    if (finding.kind === "payment")
      return recordPayment({ ...finding, evidence }, agent, { confirm: true, by: decidedBy })
    if (finding.project === undefined) return invalid("a task finding names the project the task goes in")
    const task = tasks.create(
      {
        project: finding.project,
        title: finding.title,
        type: finding.type,
        description: `${finding.commitment}: ${finding.reason}`,
        ...(finding.dueAt ? { dueAt: new Date(finding.dueAt) } : {}),
        ...(finding.externalId ? { externalId: finding.externalId } : {}),
        ...(finding.sourceUrl ? { sourceUrl: finding.sourceUrl } : {}),
      },
      agent,
    )
    const id = taskRowOf(database, task.id)
    if (id === undefined) throw new CliError("configuration_error", "created finding task is unavailable")
    linkEvidence(context, { type: finding.type, id }, quoted, "agent")
    if (finding.assignee) tasks.assign(task.id, { to: finding.assignee, role: "assignee" }, agent)
    return task.ref
  }

  /**
   * Decides what a review settles. A confirm settles the findings it names and any unchanged candidate decided
   * earlier; the rest wait for the owner. A reject (no names) settles everything still pending. A finding this batch
   * already decided keeps its outcome, so nothing is created twice.
   */
  const settle = <F extends { id: string }>(options: {
    batch: string
    account: number | null
    findings: readonly F[]
    decided: readonly FindingOutcome[]
    accepted: readonly string[]
    fingerprintOf: (finding: F) => string
    make: (finding: F) => string
  }): { items: FindingOutcome[]; pending: F[] } => {
    const { accepted } = options
    const items: FindingOutcome[] = []
    const pending: F[] = []
    for (const finding of options.findings) {
      const named = accepted.includes(finding.id)
      const done = options.decided.find((one) => one.id === finding.id)
      if (done) {
        if (named && done.status === "rejected") return invalid("this finding was already rejected")
        items.push(done)
        continue
      }
      const fingerprint = options.fingerprintOf(finding)
      const prior = previous(options.account, fingerprint, options.batch)
      if (prior) {
        if (named && prior.status === "rejected")
          return invalid("this unchanged finding was already rejected; changed evidence needs a new candidate")
        items.push({ ...prior, id: finding.id, reused: true })
        continue
      }
      if (accepted.length && !named) {
        pending.push(finding)
        continue
      }
      items.push({
        id: finding.id,
        fingerprint,
        status: named ? "accepted" : "rejected",
        reference: named ? options.make(finding) : null,
        reused: false,
      })
    }
    return { items, pending }
  }

  /** A partly reviewed batch keeps waiting: its payload carries what was decided and who was named so far. */
  const keepWaiting = (id: string, payload: object) =>
    database
      .prepare("UPDATE proposed_actions SET payload=?, updated_at=? WHERE id=? AND status='proposed'")
      .run(JSON.stringify(payload), context.now(), Number(id))

  /** The receipt's `accepted`: every finding a review of this batch named, sorted. */
  const named = (earlier: readonly string[] | undefined, now: readonly string[]): string[] =>
    [...new Set([...(earlier ?? []), ...now])].sort()

  /** A review of a batch already closed is answered again only when it asks for nothing new. */
  const sameDecision = (receipt: { accepted: string[] }, accepted: readonly string[]): boolean =>
    accepted.length ? accepted.every((one) => receipt.accepted.includes(one)) : receipt.accepted.length === 0

  return { snapshot, snapshotParts, previous, settle, keepWaiting, named, sameDecision, create }
}
