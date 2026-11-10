import { CliError } from "@wirecat/cli-base"
import { contextEvidenceFingerprint } from "../../context/evidence.js"
import { parseLocator } from "../../domain/locator.js"
import {
  checkMailFindings,
  MAIL_FINDINGS_PER_SENDER,
  type MailFinding,
  type MailFindingsInput,
  mailFindingFingerprint,
  mailFindingProblem,
  validateMailFindings,
} from "../../mail/findings.js"
import { type FindingOutcome, type FindingsReceipt, findingHash } from "../../meetings/index.js"
import { assertMayDecide, type Decider } from "../decisions.js"
import { MAIL_FINDINGS_KIND, type MailFindingsBatch, type MailFindingsStore } from "../mail-findings.js"
import { fold } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { organizationOfAddress } from "./address-organization.js"
import { financeOperationsOver } from "./finance.js"
import { findingsAgent, findingsCoreOver } from "./findings-core.js"
import { authorActor, linkEvidence, memoriesStoreOver } from "./memories.js"
import { insertLink, requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { orderOfShop, orderOperationsOver } from "./orders.js"
import { linkIdentityToPerson } from "./person-links.js"
import { type ProposedAction, proposalOperationsOver } from "./proposed-actions.js"
import { addComment } from "./task-comments.js"
import { inboxProject } from "./tasks.js"
import { taskRowOf } from "./things.js"
import { write } from "./transaction.js"
import { workTaskOperationsOver } from "./work-tasks.js"

type StoredInput = MailFindingsInput & { inputHash: string; agentModel: string | null }
type Row = Record<string, unknown>

const stale = (): never => {
  throw new CliError("validation_error", "mail findings cite mail that changed since it was read; stage a new batch", {
    reason: "mail-findings.stale",
  })
}
const invalid = (message: string, reason?: string): never => {
  throw new CliError("validation_error", message, reason ? { reason } : undefined)
}
const TEXT_BUDGET = 262144

const EMAIL = `SELECT e.id, e.account_id, e.subject, coalesce(e.body_text, '') AS body,
    json_extract(e.metadata, '$.partial') IS NOT NULL AS partial, lower(e.from_address) AS sender,
    coalesce(e.outgoing, lower(e.from_address) = lower(a.external_id)) AS outgoing
  FROM emails e JOIN email_threads t ON t.id = e.email_thread_id JOIN accounts a ON a.id = e.account_id
  WHERE a.provider = 'email' AND a.external_id = ? AND t.external_id = ? AND e.external_id = ? AND e.deleted_at IS NULL`

export const mailFindingsStoreOver = (context: StoreContext): MailFindingsStore => {
  const { database, now } = context
  const proposals = proposalOperationsOver(context)
  const core = findingsCoreOver(context, MAIL_FINDINGS_KIND)
  const memories = memoriesStoreOver(context)
  const tasks = workTaskOperationsOver(context)
  const finance = financeOperationsOver(context)
  const orders = orderOperationsOver(context)

  const mailbox = (key: AccountKey): number => {
    if (key?.provider !== "email" || typeof key.account !== "string" || !key.account.trim())
      return invalid("mail findings belong to one email account")
    const row = database
      .prepare("SELECT id FROM accounts WHERE provider = 'email' AND external_id = ?")
      .get(key.account)
    if (!row) throw new CliError("not_found", `no mail of ${key.account} is stored`)
    return Number(row.id)
  }
  const load = (id: string): ProposedAction => {
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
      return invalid("a findings batch needs a stored ID")
    const row = database
      .prepare(
        "SELECT length(CAST(payload AS BLOB)) AS bytes, length(CAST(result AS BLOB)) AS result_bytes FROM proposed_actions WHERE id = ? AND kind = ?",
      )
      .get(Number(id), MAIL_FINDINGS_KIND)
    if (!row) throw new CliError("not_found", "the mail findings batch is unavailable")
    if (Number(row.bytes) > 100000 || Number(row.result_bytes) > 65536)
      return invalid("stored findings exceed the read budget")
    return proposals.get(id)
  }
  const accountOf = (proposal: ProposedAction): number => mailbox(proposal.account as AccountKey)
  const view = (proposal: ProposedAction): MailFindingsBatch => {
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
        ? (proposal.result as FindingsReceipt).items
        : input.findings.flatMap((finding) => {
            const held = core.previous(accountOf(proposal), mailFindingFingerprint(finding))
            return held ? [{ ...held, id: finding.id, reused: true }] : []
          }),
      receipt: proposal.result as FindingsReceipt | null,
    }
  }

  /**
   * Reads each cited email once: it must be stored, whole, and hash to the fingerprint given. Every finding cites
   * mail of the batch's own mailbox, and no sender other than the owner is behind more than five findings. An email
   * gone by the time the owner decides changed since it was read; one never stored was never read.
   */
  const cite = (findings: MailFinding[], account: number, deciding = false) => {
    const read = new Map<string, Row>()
    const perSender = new Map<string, number>()
    let bytes = 0
    for (const finding of findings) {
      const senders = new Set<string>()
      let own = false
      for (const { reference, fingerprint } of finding.evidence) {
        let row = read.get(reference)
        if (!row) {
          const at = parseLocator(reference)
          row = database.prepare(EMAIL).get(at.account, at.chat, at.message)
          if (!row && deciding) return stale()
          if (!row)
            throw new CliError("not_found", `no stored email ${reference}; cite only mail a review gave`, {
              reason: "mail-findings.not-stored",
            })
          bytes += Buffer.byteLength(String(row.body)) + Buffer.byteLength(String(row.subject ?? ""))
          if (bytes > TEXT_BUDGET) return invalid(`finding evidence exceeds the ${TEXT_BUDGET}-byte stored text budget`)
          if (row.partial)
            return invalid(`${reference} is not stored whole yet; cite it once it is`, "mail-findings.partial")
          const title = row.subject == null ? null : String(row.subject)
          row.fingerprint = contextEvidenceFingerprint({
            ref: reference,
            title,
            text: String(row.body),
            revision: null,
          })
          read.set(reference, row)
        }
        if (row.fingerprint !== fingerprint) return stale()
        if (Number(row.account_id) === account) own = true
        if (!row.outgoing && row.sender != null) senders.add(String(row.sender))
      }
      if (!own) return invalid(`finding ${finding.id} cites no email of this mailbox`)
      for (const sender of senders) {
        const count = (perSender.get(sender) ?? 0) + 1
        if (count > MAIL_FINDINGS_PER_SENDER)
          return invalid(`more than ${MAIL_FINDINGS_PER_SENDER} findings from ${sender} in one batch`)
        perSender.set(sender, count)
      }
    }
    return read
  }

  /**
   * The organization a finding names but does not reference, found or made by `organizationOfAddress`. Only the
   * owner's accept runs this for real; staging runs it and rolls it back.
   */
  const organizationNamed = (name: string, email: string | undefined): string =>
    `organization:${organizationOfAddress(context, {
      name,
      ...(email === undefined ? {} : { email }),
      method: "mail-finding",
      author: "owner",
      reason: "finance.party",
    })}`
  const partyOf = (reference: string | undefined, name: string | undefined, email: string | undefined) =>
    reference ?? (name === undefined ? undefined : organizationNamed(name, email))

  /** The invoice, payment or order an accepted finding records: the owner's own entry, citing the mail it came from. */
  const entry = (finding: MailFinding, evidence: string[]): (() => { ref: string }) | undefined => {
    const by = "owner" as const
    switch (finding.kind) {
      case "invoice":
        return () =>
          finance.addInvoice({
            by,
            evidence,
            direction: finding.direction,
            counterparty: partyOf(finding.counterparty, finding.counterpartyName, finding.counterpartyEmail) as string,
            currency: finding.currency,
            lines: finding.lines,
            ...(finding.total === undefined ? {} : { total: finding.total }),
            ...(finding.number === undefined ? {} : { number: finding.number }),
            ...(finding.issueDate === undefined ? {} : { issueDate: finding.issueDate }),
            ...(finding.dueDate === undefined ? {} : { dueDate: finding.dueDate }),
            ...(finding.project === undefined ? {} : { project: finding.project }),
          })
      case "payment":
        return () => {
          const payer = partyOf(finding.payer, finding.payerName, finding.payerEmail)
          const payee = partyOf(finding.payee, finding.payeeName, finding.payeeEmail)
          return finance.addPayment({
            by,
            evidence,
            direction: finding.direction,
            amount: finding.amount,
            currency: finding.currency,
            date: finding.date,
            ...(payer === undefined ? {} : { payer }),
            ...(payee === undefined ? {} : { payee }),
            ...(finding.reference === undefined ? {} : { reference: finding.reference }),
            ...(finding.allocations === undefined ? {} : { allocations: finding.allocations }),
            ...(finding.project === undefined ? {} : { project: finding.project }),
          })
        }
      case "order": {
        const {
          id: _id,
          kind: _kind,
          evidence: _cited,
          reason: _reason,
          customer: given,
          customerName,
          customerEmail,
          ...fields
        } = finding
        return () => {
          const customer = partyOf(given, customerName, customerEmail)
          return orders.add({ ...fields, ...(customer === undefined ? {} : { customer }), by, evidence })
        }
      }
      default:
        return undefined
    }
  }

  /** Runs what accepting would write and rolls it back, so staging refuses what the owner's accept would refuse. */
  const ROLLBACK = Symbol("rollback")
  const wouldWrite = (make: () => unknown) => {
    try {
      write(database, () => {
        make()
        throw ROLLBACK
      })
    } catch (error) {
      if (error !== ROLLBACK) throw error
    }
  }

  const identityOfAddress = (address: string) =>
    database
      .prepare(
        "SELECT i.id, l.person_id FROM identities i LEFT JOIN identity_links l ON l.identity_id = i.id " +
          "WHERE i.provider = 'email' AND lower(i.external_id) = ?",
      )
      .get(address.toLowerCase())

  /** Whether `address` sent or received one of the emails `finding` cites. */
  const inCitedMail = (address: string, finding: MailFinding, read: Map<string, Row>): boolean => {
    const ids = finding.evidence.map(({ reference }) => Number(read.get(reference)?.id))
    const marks = ids.map(() => "?").join(",")
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM emails WHERE id IN (${marks}) AND lower(from_address) = ? UNION ALL ` +
            `SELECT 1 FROM email_recipients WHERE email_id IN (${marks}) AND lower(address) = ? LIMIT 1`,
        )
        .get(...ids, address, ...ids, address),
    )
  }

  /** A proposed findings batch that already holds this shop's order with this number. */
  const proposedOrder = (supplierName: string, number: string): string | undefined => {
    const shop = fold(supplierName).trim()
    return database
      .prepare(
        "SELECT p.id, json_extract(f.value, '$.supplierName') AS shop FROM proposed_actions p, " +
          "json_each(p.payload, '$.findings') f WHERE p.kind = ? AND p.status = 'proposed' " +
          "AND json_extract(f.value, '$.kind') = 'order' AND trim(json_extract(f.value, '$.number')) = ?",
      )
      .all(MAIL_FINDINGS_KIND, number.trim())
      .filter((row) => fold(String(row.shop)).trim() === shop)
      .map((row) => String(row.id))[0]
  }

  /** Whatever a finding names must be stored: a task to update, a subject, a link's ends, a contact's address. */
  const targets = (finding: MailFinding, read: Map<string, Row>) => {
    const thing = (reference: string | undefined, what: string) => {
      if (reference !== undefined) requiredThing(database, reference, what)
    }
    switch (finding.kind) {
      case "task":
        thing(finding.project, "the project")
        thing(finding.assignee, "the assignee")
        return
      case "fact":
      case "memory":
        thing(finding.subject, "the subject")
        thing(finding.project, "the project")
        return
      case "task_update":
        if (taskRowOf(database, finding.task.slice("task:".length)) === undefined)
          throw new CliError("not_found", `no task ${finding.task}`)
        return
      case "link":
        thing(finding.from, "the link's source")
        thing(finding.to, "the link's target")
        return
      case "invoice":
      case "payment":
      case "order":
        for (const address of [
          "counterpartyEmail" in finding ? finding.counterpartyEmail : undefined,
          "payerEmail" in finding ? finding.payerEmail : undefined,
          "payeeEmail" in finding ? finding.payeeEmail : undefined,
          "customerEmail" in finding ? finding.customerEmail : undefined,
        ])
          if (address !== undefined && !inCitedMail(address, finding, read))
            return invalid(`${address} neither sent nor received the mail finding ${finding.id} cites`)
        if (finding.kind === "order" && finding.number !== undefined) {
          const waiting = proposedOrder(finding.supplierName, finding.number)
          if (waiting)
            return invalid(
              `order ${finding.number} from ${finding.supplierName} already waits for the owner in findings batch ` +
                `${waiting}; leave it out, or send an order_update once it is stored and its status changes`,
              "order.proposed",
            )
        }
        wouldWrite(
          entry(
            finding,
            finding.evidence.map((one) => one.reference),
          ) as () => unknown,
        )
        return
      case "order_update":
        orderOfShop(context, finding.supplierName, finding.number)
        return
      case "new_contact": {
        if (!inCitedMail(finding.address, finding, read))
          return invalid(`${finding.address} neither sent nor received the mail finding ${finding.id} cites`)
        if (!identityOfAddress(finding.address)) throw new CliError("not_found", `no stored contact ${finding.address}`)
        return
      }
    }
  }

  /** What accepting one finding makes, inside the decision's write; returns the reference of what it made. */
  const create = (finding: MailFinding, account: AccountKey, agent: { bot: string; model?: string }): string => {
    const evidence = finding.evidence.map((one) => one.reference)
    switch (finding.kind) {
      case "fact":
        return core.create(finding, agent, "owner")
      case "task": {
        const project = finding.project ?? `project:${inboxProject(context, `email:${account.account}`, true)}`
        return core.create({ ...finding, project }, agent, "owner")
      }
      case "task_update": {
        if (finding.change === "close") tasks.editNow(finding.task, { status: "done", reason: finding.reason }, "owner")
        else if (finding.change === "due")
          tasks.editNow(finding.task, { dueAt: new Date(finding.dueAt as string) }, "owner")
        else {
          const row = taskRowOf(database, finding.task.slice("task:".length)) as number
          addComment(context, row, `${finding.detail}\n\n${evidence.join("\n")}`, agent)
        }
        return finding.task
      }
      case "memory": {
        const made = memories.addNow({
          kind: finding.memoryKind,
          body: finding.body,
          scope: finding.scope,
          evidence,
          author: agent,
          ...(finding.subject === undefined ? {} : { subject: finding.subject }),
          ...(finding.project === undefined ? {} : { project: finding.project }),
        })
        return memories.confirmNow(made.ref, "owner").ref
      }
      case "link": {
        if (finding.from.startsWith("contact:")) {
          const identity = requiredThing(database, finding.from, "the contact")
          const person = requiredThing(database, finding.to, "the person")
          linkIdentityToPerson(context, identity.id, person.id, { method: "mail-finding", by: "owner" })
          return finding.to
        }
        const link = insertLink(context, {
          from: finding.from,
          to: finding.to,
          kind: "member-of",
          origin: "owner",
          evidence: evidence[0] as string,
          provenance: `${agent.bot}: ${finding.reason}`,
        })
        if (!link.confirmed)
          database.prepare("UPDATE links SET confirmed = 1, updated_at = ? WHERE id = ?").run(now(), Number(link.id))
        return `link:${link.id}`
      }
      case "invoice":
      case "payment":
      case "order":
        return (entry(finding, evidence) as () => { ref: string })().ref
      case "order_update": {
        const order = orderOfShop(context, finding.supplierName, finding.number)
        orders.setStatus(order, {
          status: finding.status,
          by: "owner",
          ...(finding.date === undefined ? {} : { date: finding.date }),
        })
        linkEvidence(context, { type: "order", id: Number(order.slice("order:".length)) }, evidence, "owner")
        return order
      }
      case "new_contact": {
        const person = Number(identityOfAddress(finding.address)?.person_id)
        database
          .prepare("UPDATE persons SET name = ?, updated_at = ? WHERE id = ? AND owner = 0")
          .run(finding.name, now(), person)
        return `person:${person}`
      }
    }
  }

  /** The batch this agent already staged under the input's key: the same input's, or a refusal for another's. */
  /** `whole` is false for a checked batch that lost findings to their problems: no staged input can equal it. */
  const heldBatch = (account: number, input: MailFindingsInput, by: ReturnType<typeof findingsAgent>, whole = true) => {
    const { actor } = authorActor(context, by)
    const held = database
      .prepare(
        "SELECT id FROM proposed_actions WHERE account_id = ? AND kind = ? AND proposed_by_type = ? AND proposed_by_id = ? AND json_extract(payload, '$.key') = ? ORDER BY id LIMIT 1",
      )
      .get(account, MAIL_FINDINGS_KIND, actor.type, actor.id, input.key)
    if (!held) return undefined
    const proposal = load(String(held.id))
    if (!whole || (proposal.payload as StoredInput).inputHash !== findingHash({ input, model: by.model ?? null }))
      return invalid(
        `the findings batch key ${input.key} was already used for different input (batch ${proposal.id}); ` +
          "check a batch with --dry-run before staging it",
        "mail-findings.key-used",
      )
    return proposal
  }

  return {
    stage: async (key, raw, rawAgent) => {
      const input = validateMailFindings(raw)
      const by = findingsAgent(rawAgent)
      return write(database, () => {
        const account = mailbox(key)
        const inputHash = findingHash({ input, model: by.model ?? null })
        const held = heldBatch(account, input, by)
        if (held) return view(held)
        const read = cite(input.findings, account)
        for (const finding of input.findings) targets(finding, read)
        const fingerprints = input.findings.map(mailFindingFingerprint)
        if (new Set(fingerprints).size !== fingerprints.length) return invalid("the batch contains duplicate findings")
        return view(
          proposals.propose({
            kind: MAIL_FINDINGS_KIND,
            by,
            account: { provider: "email", account: key.account },
            payload: { ...input, inputHash, agentModel: by.model ?? null },
          }),
        )
      })
    },
    check: async (key, raw, rawAgent) => {
      const { batch: input, problems } = checkMailFindings(raw)
      const by = findingsAgent(rawAgent)
      const batchProblem = (error: unknown) => problems.push(mailFindingProblem(null, error))
      let batch: string | null = null
      // authorActor and the trial writes touch the store; everything here is rolled back.
      wouldWrite(() => {
        const account = mailbox(key)
        try {
          batch = heldBatch(account, input, by, problems.length === 0)?.id ?? null
        } catch (error) {
          batchProblem(error)
        }
        if (batch !== null) return
        const valid: MailFinding[] = []
        for (const finding of input.findings) {
          try {
            targets(finding, cite([finding], account))
            valid.push(finding)
          } catch (error) {
            problems.push(mailFindingProblem(finding, error))
          }
        }
        try {
          if (valid.length === input.findings.length) cite(valid, account)
          const fingerprints = valid.map(mailFindingFingerprint)
          if (new Set(fingerprints).size !== fingerprints.length) invalid("the batch contains duplicate findings")
        } catch (error) {
          batchProblem(error)
        }
      })
      return { valid: problems.length === 0, findings: raw.findings?.length ?? 0, batch, problems }
    },
    get: async (id) => view(load(id)),
    list: async ({ account, status, limit = 20, offset = 0 } = {}) => {
      if (status !== undefined && status !== "proposed" && status !== "reviewed")
        return invalid("finding status is proposed or reviewed")
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0)
        return invalid("findings lists take 1–50 items and a nonnegative offset")
      const id = account === undefined ? null : mailbox(account)
      const rows = database
        .prepare(
          "SELECT id FROM proposed_actions WHERE kind = ? AND (? IS NULL OR account_id = ?) AND (? IS NULL OR status = ?) " +
            "ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(
          MAIL_FINDINGS_KIND,
          id,
          id,
          status ?? null,
          status === "reviewed" ? "approved" : (status ?? null),
          limit + 1,
          offset,
        )
      return { items: rows.slice(0, limit).map((row) => view(load(String(row.id)))), hasMore: rows.length > limit }
    },
    review: async (id, decision) =>
      write(database, () => {
        const proposal = load(id)
        const batch = view(proposal)
        if (!decision || typeof decision.fingerprint !== "string" || decision.fingerprint !== batch.fingerprint)
          return stale()
        if (
          !Array.isArray(decision.accept) ||
          decision.accept.length > batch.input.findings.length ||
          new Set(decision.accept).size !== decision.accept.length ||
          decision.accept.some((candidate) => !batch.input.findings.some((finding) => finding.id === candidate))
        )
          return invalid("accept only unique IDs shown in this batch")
        if (decision.by === undefined) return invalid("a findings review names who decides: the owner")
        assertMayDecide(
          { id, kind: MAIL_FINDINGS_KIND, proposedBy: proposals.proposer(id) },
          decision.by,
          context.decisions,
        )
        const accepted = [...decision.accept].sort()
        if (batch.receipt) {
          if (JSON.stringify(batch.receipt.accepted) !== JSON.stringify(accepted))
            return invalid("this findings batch was already reviewed with a different decision")
          return batch
        }
        const input = proposal.payload as StoredInput
        const account = accountOf(proposal)
        // Rejecting creates nothing, so a batch whose mail changed can still be closed; accepting needs the
        // accepted findings' own mail unchanged.
        const chosen = batch.input.findings.filter((finding) => accepted.includes(finding.id))
        if (chosen.length) cite(chosen, account, true)
        if (proposal.proposedBy.type !== "bot" || !proposal.proposedBy.name)
          return invalid("a findings author must be an agent")
        const agent = {
          bot: proposal.proposedBy.name,
          ...(input.agentModel === null ? {} : { model: input.agentModel }),
        }
        const items = batch.input.findings.map((finding): FindingOutcome => {
          const fingerprint = mailFindingFingerprint(finding)
          const prior = core.previous(account, fingerprint)
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
            reference: status === "accepted" ? create(finding, batch.account, agent) : null,
            reused: false,
          }
        })
        return view(
          proposals.approve(
            id,
            { previewFingerprint: batch.fingerprint, accepted, items } satisfies FindingsReceipt,
            "owner" satisfies Decider,
          ),
        )
      }),
  }
}
