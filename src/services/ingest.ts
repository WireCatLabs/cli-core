import { createInterface } from "node:readline"
import {
  type EnvelopeOptions,
  type EnvelopeRecord,
  type EnvelopeSource,
  envelopeErrors,
  headerErrors,
  type IngestError,
  jsonLine,
  pointerOf,
  type RecordsEnvelope,
  recordErrors,
} from "../domain/records.js"
import { envelopeOfVcard, type VcardIssue, type VcardOptions } from "../domain/vcard.js"
import { type RecordsRun, type RunItem, waitingPointer } from "../store/index.js"
import type { MessageStore } from "../store/store.js"

export interface IngestOptions {
  /** The account the caller means; the envelope's `source.account` must be this one. */
  account: string
  /** Checks and plans everything, then writes nothing. */
  dryRun?: boolean
  /** Records per transaction, 1000 by default. */
  chunk?: number
  /** Every refusal as it happens, also the ones past the receipt's 1000. It must not use the store (see `RunOptions`). */
  onIssue?: (issue: IngestError) => void
}

export type IngestLinesOptions = IngestOptions

export interface IngestReceipt {
  dryRun: boolean
  source: { provider: string; account: string; batchId: string } | null
  created: number
  updated: number
  unchanged: number
  deleted: number
  refused: number
  /** The proposals this import made or changed, of every type that feeds money; the owner decides them in review. */
  proposed: string[]
  /** Kept, with no entity yet: each named role or field points at a record not imported, or one with no entity. */
  waiting: { key: string; pointer: string; missing: string[] }[]
  /**
   * Changed or deleted at the source after the entity was made from it: the entity was not touched. `reason` and
   * `candidates` say when the change named another entity's identifiers.
   */
  flagged: { key: string; pointer: string; entity: string; reason?: string; candidates?: string[] }[]
  /**
   * A person, organization or project whose identifiers point at more than one entity (`record.ambiguous`), or at one
   * the owner separated from them (`record.separated`): it waits, and the owner says which one it is.
   */
  unmatched: { key: string; pointer: string; reason: string; candidates: string[] }[]
  /**
   * Values that look like an identifier and were kept as data only, never matched: a phone without `+` when the
   * envelope names no `options.phone_region` (`record.phone-region`).
   */
  ignored: { key: string; pointer: string; reason: string }[]
  errors: IngestError[]
  /** A list stopped at 1000 entries; the counts are exact. */
  truncated: boolean
}

const emptyReceipt = (dryRun: boolean, errors: IngestError[]): IngestReceipt => ({
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
  unmatched: [],
  ignored: [],
  errors,
  truncated: false,
})

const receiptOf = (dryRun: boolean, source: EnvelopeSource, run: RecordsRun): IngestReceipt => ({
  dryRun,
  source: { provider: source.provider, account: source.account, batchId: source.batch_id },
  created: run.created,
  updated: run.updated,
  unchanged: run.unchanged,
  deleted: run.deleted,
  refused: run.refused,
  proposed: run.proposed,
  waiting: run.waiting.map(({ index, key, missing }) => ({ key, pointer: waitingPointer(index, missing), missing })),
  flagged: run.flagged.map(({ index, ...flag }) => ({ ...flag, pointer: pointerOf("records", index) })),
  unmatched: run.unmatched.map(({ index, key, reason, candidates }) => ({
    key,
    pointer: pointerOf("records", index, "fields"),
    reason,
    candidates,
  })),
  ignored: run.ignored.map(({ index, key, at, reason }) => ({
    key,
    pointer: pointerOf("records", index, ...at),
    reason,
  })),
  errors: run.errors,
  truncated: run.truncated,
})

const itemOf = (record: unknown, index: number): RunItem => {
  const errors = recordErrors(record, index)
  return { index, record: record as EnvelopeRecord, ...(errors.length > 0 ? { errors } : {}) }
}

const refusedAll = (dryRun: boolean, errors: IngestError[], onIssue?: (issue: IngestError) => void) => {
  for (const error of errors) onIssue?.(error)
  return emptyReceipt(dryRun, errors)
}

/**
 * Takes a v1 records envelope into the store: checks it, then writes per chunk in one transaction. The same import
 * twice writes nothing new. A record with a lower revision than the stored one is refused, a delete is soft, a
 * reference to a record not yet imported waits for it, and nothing is linked by name: a person, organization or
 * project is linked by an exact strong identifier, or made. What feeds money totals becomes a proposal: an import
 * never writes confirmed money.
 */
export const ingest = async (
  store: Pick<MessageStore, "records">,
  envelope: unknown,
  { account, dryRun = false, chunk = 1000, onIssue }: IngestOptions,
): Promise<IngestReceipt> => {
  const broken = envelopeErrors(envelope, account)
  if (broken.length > 0) return refusedAll(dryRun, broken, onIssue)
  const { source, records, options } = envelope as RecordsEnvelope
  const items = (records as unknown[]).map(itemOf)
  return receiptOf(dryRun, source, await store.records.run(source, items, { dryRun, chunk, options, onIssue }))
}

/** The lines of a file or of stdin, one at a time, never the whole text. */
export const jsonlLines = (stream: NodeJS.ReadableStream): AsyncIterable<string> =>
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })

/**
 * `ingest` over a JSONL stream: the first non-empty line is the header (`schema_version`, `source`, `options`), each
 * further non-empty line one record. Records are written per chunk as they arrive; a dry run is one transaction
 * rolled back at the end, holding the store's write lock until then.
 */
export const ingestLines = async (
  store: Pick<MessageStore, "records">,
  lines: AsyncIterable<string>,
  { account, dryRun = false, chunk = 1000, onIssue }: IngestOptions,
): Promise<IngestReceipt> => {
  const iterator = lines[Symbol.asyncIterator]()
  let header: unknown = {}
  for (let next = await iterator.next(); !next.done; next = await iterator.next())
    if (next.value.trim() !== "" && next.value !== "﻿") {
      header = jsonLine(next.value)
      break
    }
  const broken = headerErrors(header, account)
  if (broken.length > 0) {
    await iterator.return?.()
    return refusedAll(dryRun, broken, onIssue)
  }
  const { source, options } = header as { source: EnvelopeSource; options?: EnvelopeOptions }
  async function* items(): AsyncIterable<RunItem> {
    let index = 0
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      if (next.value.trim() === "") continue
      yield itemOf(jsonLine(next.value), index)
      index += 1
    }
  }
  return receiptOf(dryRun, source, await store.records.run(source, items(), { dryRun, chunk, options, onIssue }))
}

export interface IngestVcardOptions extends IngestOptions, Omit<VcardOptions, "account"> {}

/**
 * A `.vcf` address book (`isVcard`) through `envelopeOfVcard`, then `ingest`: the receipt, and what the converter kept
 * without matching (a national number with no `region`, a card repeated in the file).
 */
export const ingestVcard = async (
  store: Pick<MessageStore, "records">,
  text: string,
  { provider, batchId, region, ...options }: IngestVcardOptions,
): Promise<IngestReceipt & { vcard: VcardIssue[] }> => {
  const { envelope, issues } = envelopeOfVcard(text, {
    provider,
    account: options.account,
    batchId,
    ...(region === undefined ? {} : { region }),
  })
  return { ...(await ingest(store, envelope, options)), vcard: issues }
}
