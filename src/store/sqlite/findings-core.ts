import { CliError } from "@wirecat/cli-base"
import {
  type Finding,
  type FindingEvidence,
  type FindingOutcome,
  type FindingsInput,
  findingFingerprint,
  findingHash,
} from "../../meetings/index.js"
import { factOperationsOver } from "./facts.js"
import { linkEvidence } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
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
 * What meeting and evidence findings share: the project and assignee snapshot, earlier decisions on an unchanged
 * candidate, creating the accepted facts and tasks, and the receipt items. Each kind checks its own evidence,
 * including a reference it already saw for another finding.
 */
export const findingsCoreOver = (context: StoreContext, kind: string) => {
  const { database } = context
  const facts = factOperationsOver(context)
  const tasks = workTaskOperationsOver(context)

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

  const previous = (account: number | null, fingerprint: string): FindingOutcome | undefined => {
    const row = database
      .prepare(
        "SELECT substr(j.value,1,4096) AS item FROM proposed_actions p,json_each(p.result,'$.items') j WHERE p.account_id IS ? AND p.kind=? AND p.status='approved' AND json_extract(j.value,'$.fingerprint')=? ORDER BY p.id LIMIT 1",
      )
      .get(account, kind, fingerprint)
    return row ? (JSON.parse(String(row.item)) as FindingOutcome) : undefined
  }

  const create = (finding: Finding, agent: FindingsAgent): string => {
    const evidence = finding.evidence.map((item) => item.reference)
    if (finding.kind === "fact") {
      const fact = facts.add({
        type: finding.type,
        statement: finding.statement,
        ...(finding.project === undefined ? {} : { project: finding.project }),
        ...(finding.subject === undefined ? {} : { subject: finding.subject }),
        evidence,
        by: agent,
      })
      return facts.accept(fact.ref).ref
    }
    if (finding.project === undefined) return invalid("a task finding names the project the task goes in")
    const task = tasks.create(
      {
        project: finding.project,
        title: finding.title,
        type: finding.type,
        description: `${finding.commitment}: ${finding.reason}`,
        ...(finding.dueAt ? { dueAt: new Date(finding.dueAt) } : {}),
      },
      agent,
    )
    const id = taskRowOf(database, task.id)
    if (id === undefined) throw new CliError("configuration_error", "created finding task is unavailable")
    linkEvidence(context, { type: finding.type, id }, evidence, "agent")
    if (finding.assignee) tasks.assign(task.id, { to: finding.assignee, role: "assignee" }, agent)
    return task.ref
  }

  /** Reuses an earlier decision on an unchanged candidate; refuses to accept one that was rejected. */
  const outcomes = (account: number | null, input: FindingsInput, accepted: string[], agent: FindingsAgent) =>
    input.findings.map((finding): FindingOutcome => {
      const fingerprint = findingFingerprint(finding)
      const prior = previous(account, fingerprint)
      if (prior) {
        if (accepted.includes(finding.id) && prior.status === "rejected")
          return invalid("this unchanged finding was already rejected; changed evidence needs a new candidate")
        return { ...prior, id: finding.id, reused: true }
      }
      const status = accepted.includes(finding.id) ? "accepted" : "rejected"
      return {
        id: finding.id,
        fingerprint,
        status,
        reference: status === "accepted" ? create(finding, agent) : null,
        reused: false,
      }
    })

  return { snapshot, snapshotParts, previous, outcomes }
}
