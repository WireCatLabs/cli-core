import { CliError } from "@wirecat/cli-base"
import {
  findingHash,
  MEETING_FINDINGS_KIND,
  type MeetingFindingsInput,
  type MeetingFindingsReceipt,
  meetingCueFingerprint,
  meetingFindingFingerprint,
  parseMeetingReference,
  validateMeetingFindings,
} from "../../meetings/index.js"
import type { MeetingFindingsBatch, MeetingFindingsStore } from "../meeting-findings.js"
import type { AccountKey } from "../types.js"
import { findingsCoreOver } from "./findings-core.js"
import { authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { type ProposedAction, proposalOperationsOver } from "./proposed-actions.js"
import { write } from "./transaction.js"

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
    if (!input || !proposal.account || !["proposed", "approved", "rejected"].includes(proposal.status))
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
  const core = findingsCoreOver(context, MEETING_FINDINGS_KIND)
  const snapshot = (account: number, input: MeetingFindingsInput): string => {
    let readBytes = 0
    return core.snapshot(input, (evidence, finding, projectId, seen) => {
      const parsed = parseMeetingReference(evidence.reference)
      if (parsed.accountId !== account) throw new CliError("not_found", "the cited cue belongs to another account")
      const membership = database
        .prepare(
          "SELECT id,updated_at,confirmed,source FROM links WHERE from_type='meeting' AND from_id=? AND to_type='project' AND to_id=? AND kind='member-of' AND anchor IS NULL AND confirmed=1",
        )
        .get(parsed.meetingId, projectId)
      if (!membership) return invalid("each cited meeting needs confirmed membership in the finding's project")
      seen.set(`${finding.project}/${parsed.meetingId}`, membership)
      if (seen.has(evidence.reference)) {
        if (seen.get(evidence.reference) !== evidence.fingerprint) return stale()
        return
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
    })
  }
  const previous = core.previous
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
        // Rejecting creates nothing, so a batch whose evidence changed can still be closed.
        if (accepted.length && snapshot(account, batch.input) !== input.snapshotHash) return stale()
        if (proposal.proposedBy.type !== "bot" || !proposal.proposedBy.name)
          return invalid("a findings author must be an agent")
        const agent = {
          bot: proposal.proposedBy.name,
          ...(input.agentModel === null ? {} : { model: input.agentModel }),
        }
        const items = core.outcomes(account, batch.input, accepted, agent)
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
