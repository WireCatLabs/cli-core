import { CliError } from "@wirecat/cli-base"
import { meetingCueFingerprint } from "../../meetings/cue-fingerprint.js"
import {
  type FindingOutcome,
  findingHash,
  MEETING_FINDINGS_KIND,
  type MeetingFinding,
  type MeetingFindingsBatch,
  type MeetingFindingsInput,
  type MeetingFindingsReceipt,
  type MeetingFindingsStore,
  meetingFindingFingerprint,
  validateMeetingFindings,
} from "../../meetings/findings.js"
import { parseMeetingReference } from "../../meetings/reference.js"
import type { AccountKey } from "../types.js"
import { factOperationsOver } from "./facts.js"
import { authorActor, linkEvidence } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { type ProposedAction, proposalOperationsOver } from "./proposed-actions.js"
import { taskRowOf } from "./things.js"
import { write } from "./transaction.js"
import { workTaskOperationsOver } from "./work-tasks.js"

type StoredInput = MeetingFindingsInput & { inputHash: string; snapshotHash: string; agentModel: string | null }
const stale = (): never => {
  throw new CliError("validation_error", "meeting findings changed since they were read; stage a new batch", {
    reason: "meeting-findings.stale",
  })
}
const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}

export const meetingFindingsStoreOver = (context: StoreContext): MeetingFindingsStore => {
  const { database } = context
  const proposals = proposalOperationsOver(context)
  const facts = factOperationsOver(context)
  const tasks = workTaskOperationsOver(context)
  const accountId = (key: AccountKey): number => {
    if (
      !key ||
      typeof key.provider !== "string" ||
      !key.provider.trim() ||
      typeof key.account !== "string" ||
      !key.account.trim()
    )
      return invalid("choose a meeting provider and account")
    const row = database
      .prepare("SELECT id,scope FROM accounts WHERE provider=? AND external_id=?")
      .get(key.provider, key.account)
    if (!row || (key.scope !== undefined && row.scope !== key.scope))
      throw new CliError("not_found", "the meeting account is unavailable")
    return Number(row.id)
  }
  const load = (account: number, id: string): ProposedAction => {
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
      return invalid("a findings batch needs a stored ID")
    const row = database
      .prepare(
        "SELECT length(CAST(payload AS BLOB)) AS bytes,length(CAST(result AS BLOB)) AS result_bytes FROM proposed_actions WHERE id=? AND account_id=? AND kind=?",
      )
      .get(Number(id), account, MEETING_FINDINGS_KIND)
    if (!row) throw new CliError("not_found", "the findings batch is unavailable for this account")
    if (Number(row.bytes) > 100000 || Number(row.result_bytes) > 65536)
      return invalid("stored findings exceed the read budget")
    return proposals.get(id)
  }
  const view = (proposal: ProposedAction): MeetingFindingsBatch => {
    const input = proposal.payload as StoredInput
    if (!input || !proposal.account || !["proposed", "approved"].includes(proposal.status))
      return invalid("invalid stored findings batch")
    return {
      id: proposal.id,
      account: proposal.account,
      input: { schemaVersion: 1, key: input.key, extractor: input.extractor, findings: input.findings },
      fingerprint: findingHash({ input, author: proposal.proposedBy.id }),
      status: proposal.status === "proposed" ? "proposed" : "reviewed",
      author: proposal.proposedBy,
      decidedBy: proposal.decidedBy,
      decidedAt: proposal.decidedAt,
      previous: proposal.result
        ? (proposal.result as MeetingFindingsReceipt).items
        : input.findings.flatMap((finding) => {
            const held = previous(accountId(proposal.account as AccountKey), meetingFindingFingerprint(finding))
            return held ? [{ ...held, id: finding.id, reused: true }] : []
          }),
      receipt: proposal.result as MeetingFindingsReceipt | null,
    }
  }
  const snapshot = (account: number, input: MeetingFindingsInput): string => {
    let readBytes = 0
    const seen = new Map<string, unknown>()
    for (const finding of input.findings) {
      const project = requiredThing(database, finding.project, "the project")
      if (project.type !== "project") return invalid("a finding needs an owner project")
      const projectRow = database
        .prepare(
          "SELECT id,key,name,description,type,scope,updated_at FROM projects WHERE id=? AND account_id IS NULL AND deleted_at IS NULL",
        )
        .get(project.id)
      if (!projectRow) throw new CliError("not_found", "the owner project is unavailable")
      seen.set(finding.project, projectRow)
      if (finding.kind === "task" && finding.assignee) {
        const person = requiredThing(database, finding.assignee, "the assignee")
        if (person.type !== "person") return invalid("the assignee must be a stored person")
        const personRow = database.prepare("SELECT id,name,updated_at FROM persons WHERE id=?").get(person.id)
        if (!personRow) throw new CliError("not_found", "the assignee is unavailable")
        seen.set(finding.assignee, personRow)
      }
      for (const evidence of finding.evidence) {
        const parsed = parseMeetingReference(evidence.reference)
        if (parsed.accountId !== account) throw new CliError("not_found", "the cited cue belongs to another account")
        const membership = database
          .prepare(
            "SELECT id,updated_at,confirmed,source FROM links WHERE from_type='meeting' AND from_id=? AND to_type='project' AND to_id=? AND kind='member-of' AND anchor IS NULL AND confirmed=1",
          )
          .get(parsed.meetingId, project.id)
        if (!membership) return invalid("each cited meeting needs confirmed membership in the finding's project")
        seen.set(`${finding.project}/${parsed.meetingId}`, membership)
        if (seen.has(evidence.reference)) {
          if (seen.get(evidence.reference) !== evidence.fingerprint) return stale()
          continue
        }
        const query =
          "FROM meeting_transcript_rows r JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id WHERE m.id=? AND m.account_id=? AND m.deleted_at IS NULL AND t.id=? AND t.deleted_at IS NULL AND t.superseded_at IS NULL AND r.position=?"
        const params = [parsed.meetingId, account, parsed.transcriptId as number, parsed.cuePosition as number]
        const budget = database
          .prepare(
            `SELECT length(CAST(r.text AS BLOB))+coalesce(length(CAST(r.speaker_name AS BLOB)),0)+coalesce(length(CAST(t.content_hash AS BLOB)),0) AS bytes ${query}`,
          )
          .get(...params)
        if (!budget) return stale()
        readBytes += Number(budget.bytes)
        if (!Number.isSafeInteger(readBytes) || readBytes > 65536)
          return invalid("finding evidence exceeds the 65536-byte stored text budget")
        const row = database
          .prepare(`SELECT t.content_hash,r.start_ms,r.end_ms,r.speaker_participant_id,r.speaker_name,r.text ${query}`)
          .get(...params)
        if (!row) return stale()
        const fingerprint = meetingCueFingerprint({
          reference: evidence.reference,
          transcriptId: parsed.transcriptId as number,
          contentHash: row.content_hash == null ? null : String(row.content_hash),
          position: parsed.cuePosition as number,
          startMs: Number(row.start_ms),
          endMs: Number(row.end_ms),
          speakerParticipantId: row.speaker_participant_id == null ? null : Number(row.speaker_participant_id),
          speakerName: row.speaker_name == null ? null : String(row.speaker_name),
          text: String(row.text),
        })
        if (fingerprint !== evidence.fingerprint) return stale()
        seen.set(evidence.reference, fingerprint)
      }
    }
    return findingHash([...seen].sort(([a], [b]) => a.localeCompare(b)))
  }
  const previous = (account: number, fingerprint: string): FindingOutcome | undefined => {
    const row = database
      .prepare(
        "SELECT substr(j.value,1,4096) AS item FROM proposed_actions p,json_each(p.result,'$.items') j WHERE p.account_id=? AND p.kind=? AND p.status='approved' AND json_extract(j.value,'$.fingerprint')=? ORDER BY p.id LIMIT 1",
      )
      .get(account, MEETING_FINDINGS_KIND, fingerprint)
    return row ? (JSON.parse(String(row.item)) as FindingOutcome) : undefined
  }
  const create = (finding: MeetingFinding, agent: { bot: string; model?: string }): string => {
    const evidence = finding.evidence.map((item) => item.reference)
    if (finding.kind === "fact") {
      const fact = facts.add({
        type: finding.type,
        statement: finding.statement,
        project: finding.project,
        evidence,
        by: agent,
      })
      return facts.accept(fact.ref).ref
    }
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
  return {
    stage: async (key, raw, agent) => {
      const input = validateMeetingFindings(raw)
      if (
        !agent ||
        typeof agent.bot !== "string" ||
        !agent.bot.trim() ||
        agent.bot.length > 200 ||
        agent.bot === "owner" ||
        (agent.model !== undefined && (typeof agent.model !== "string" || agent.model.length > 200))
      )
        return invalid("findings must name an agent author independently of their payload")
      const by = { bot: agent.bot, ...(agent.model === undefined ? {} : { model: agent.model }) }
      return write(database, () => {
        const account = accountId(key)
        const { actor } = authorActor(context, by)
        const inputHash = findingHash({ input, model: by.model ?? null })
        const held = database
          .prepare(
            "SELECT id FROM proposed_actions WHERE account_id=? AND kind=? AND proposed_by_type=? AND proposed_by_id=? AND json_extract(payload,'$.key')=? ORDER BY id LIMIT 1",
          )
          .get(account, MEETING_FINDINGS_KIND, actor.type, actor.id, input.key)
        if (held) {
          const proposal = load(account, String(held.id))
          if ((proposal.payload as StoredInput).inputHash !== inputHash)
            return invalid("the findings batch key was already used for different input")
          return view(proposal)
        }
        const snapshotHash = snapshot(account, input)
        const fingerprints = input.findings.map(meetingFindingFingerprint)
        if (new Set(fingerprints).size !== fingerprints.length) return invalid("the batch contains duplicate findings")
        return view(
          proposals.propose({
            kind: MEETING_FINDINGS_KIND,
            by,
            account: key,
            payload: { ...input, inputHash, snapshotHash, agentModel: by.model ?? null },
          }),
        )
      })
    },
    get: async (key, id) => view(load(accountId(key), id)),
    list: async (key, { limit = 20, offset = 0, status } = {}) => {
      if (status !== undefined && status !== "proposed" && status !== "reviewed")
        return invalid("finding status is proposed or reviewed")
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0)
        return invalid("findings lists take 1–50 items and a nonnegative offset")
      const account = accountId(key)
      const ids = database
        .prepare(
          "SELECT id FROM proposed_actions WHERE account_id=? AND kind=? AND (? IS NULL OR status=?) ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(
          account,
          MEETING_FINDINGS_KIND,
          status ?? null,
          status === "reviewed" ? "approved" : (status ?? null),
          limit + 1,
          offset,
        )
      return {
        items: ids.slice(0, limit).map((row) => view(load(account, String(row.id)))),
        hasMore: ids.length > limit,
      }
    },
    review: async (key, id, decision) =>
      write(database, () => {
        const account = accountId(key)
        const proposal = load(account, id)
        const batch = view(proposal)
        if (!decision || typeof decision.fingerprint !== "string" || decision.fingerprint !== batch.fingerprint)
          return stale()
        if (
          !Array.isArray(decision.accept) ||
          decision.accept.length > 16 ||
          new Set(decision.accept).size !== decision.accept.length ||
          decision.accept.some((candidate) => !batch.input.findings.some((finding) => finding.id === candidate))
        )
          return invalid("accept only unique IDs shown in this batch")
        const accepted = [...decision.accept].sort()
        if (batch.receipt) {
          if (JSON.stringify(batch.receipt.accepted) !== JSON.stringify(accepted))
            return invalid("this findings batch was already reviewed with a different decision")
          return batch
        }
        const input = proposal.payload as StoredInput
        if (snapshot(account, batch.input) !== input.snapshotHash) return stale()
        if (proposal.proposedBy.type !== "bot" || !proposal.proposedBy.name)
          return invalid("a findings author must be an agent")
        const agent = {
          bot: proposal.proposedBy.name,
          ...(input.agentModel === null ? {} : { model: input.agentModel }),
        }
        const items = batch.input.findings.map((finding): FindingOutcome => {
          const fingerprint = meetingFindingFingerprint(finding)
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
        return view(
          proposals.approve(id, {
            previewFingerprint: batch.fingerprint,
            accepted,
            items,
          } satisfies MeetingFindingsReceipt),
        )
      }),
  }
}
