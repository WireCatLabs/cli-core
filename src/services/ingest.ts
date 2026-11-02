import {
  type EnvelopeRecord,
  envelopeErrors,
  type IngestError,
  pointerOf,
  type RecordsEnvelope,
  recordErrors,
} from "../domain/records.js"
import type { MessageStore } from "../store/store.js"

export interface IngestOptions {
  /** The account the caller means; the envelope's `source.account` must be this one. */
  account: string
  /** Checks and plans everything, then writes nothing. */
  dryRun?: boolean
  /** Records per transaction, 1000 by default. */
  chunk?: number
}

export interface IngestReceipt {
  dryRun: boolean
  source: { provider: string; account: string; batchId: string } | null
  created: number
  updated: number
  unchanged: number
  deleted: number
  refused: number
  /** `invoice:` and `payment:` proposals this import made; the owner confirms them in review. */
  proposed: string[]
  /** Kept, with no entity yet: each named role points at a record not imported, or one with no entity. */
  waiting: { key: string; pointer: string; missing: string[] }[]
  /** Changed or deleted at the source after the entity was made from it: the entity was not touched. */
  flagged: { key: string; pointer: string; entity: string }[]
  errors: IngestError[]
}

const emptyReceipt = (dryRun: boolean): IngestReceipt => ({
  dryRun,
  source: null,
  created: 0,
  updated: 0,
  unchanged: 0,
  deleted: 0,
  refused: 0,
  proposed: [],
  waiting: [],
  flagged: [],
  errors: [],
})

/**
 * Takes a v1 records envelope (or `envelopeOfJsonl` of a JSONL file) into the store: checks it, then writes per
 * chunk in one transaction. The same import twice writes nothing new. A record with a lower revision than the stored
 * one is refused, a delete is soft, a reference to a record not yet imported waits for it, and nothing is linked by
 * name. An invoice or a payment becomes a proposal: an import never writes confirmed money.
 */
export const ingest = async (
  store: Pick<MessageStore, "records">,
  envelope: unknown,
  { account, dryRun = false, chunk = 1000 }: IngestOptions,
): Promise<IngestReceipt> => {
  const receipt = emptyReceipt(dryRun)
  const broken = envelopeErrors(envelope, account)
  if (broken.length > 0) return { ...receipt, errors: broken }
  const { source, records } = envelope as RecordsEnvelope
  receipt.source = { provider: source.provider, account: source.account, batchId: source.batch_id }

  const taken: { index: number; record: EnvelopeRecord }[] = []
  const keys = new Set<string>()
  const identities = new Set<string>()
  for (const [index, record] of (records as unknown[]).entries()) {
    const errors = recordErrors(record, index)
    const valid = record as EnvelopeRecord
    if (errors.length === 0 && keys.has(valid.key))
      errors.push({
        pointer: pointerOf("records", index, "key"),
        code: "record.duplicate-key",
        message: "another record of this envelope has this key",
        key: valid.key,
      })
    const identity = errors.length === 0 ? `${valid.type}\0${valid.external_id}` : ""
    if (errors.length === 0 && identities.has(identity))
      errors.push({
        pointer: pointerOf("records", index, "external_id"),
        code: "record.duplicate",
        message: `another record of this envelope is ${valid.type} ${valid.external_id}`,
        key: valid.key,
      })
    if (errors.length > 0) {
      receipt.refused += 1
      for (const error of errors) receipt.errors.push(error)
      continue
    }
    keys.add(valid.key)
    identities.add(identity)
    taken.push({ index, record: valid })
  }

  const written = await store.records.write(source, taken, { dryRun, chunk })
  for (const outcome of written.outcomes) {
    receipt[outcome.status] += 1
    if (outcome.error) receipt.errors.push(outcome.error)
  }
  for (const error of written.laterErrors) receipt.errors.push(error)
  receipt.errors.sort((a, b) => a.pointer.localeCompare(b.pointer, "en", { numeric: true }))
  receipt.proposed = written.proposed
  receipt.waiting = written.waiting.map(({ index, key, missing }) => ({
    key,
    pointer: pointerOf("records", index, "relations"),
    missing,
  }))
  receipt.flagged = written.flagged.map(({ index, key, entity }) => ({
    key,
    pointer: pointerOf("records", index),
    entity,
  }))
  return receipt
}
