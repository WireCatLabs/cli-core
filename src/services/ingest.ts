import { createInterface } from "node:readline"
import {
  type EnvelopeOptions,
  type EnvelopeRecord,
  type EnvelopeSource,
  envelopeErrors,
  headerErrors,
  type IngestError,
  pointerOf,
  type RecordsEnvelope,
  recordErrors,
} from "../domain/records.js"
import type { MessageStore } from "../store/store.js"

type Records = MessageStore["records"]
type RecordsRun = Awaited<ReturnType<Records["run"]>>
type RunItem = Parameters<Records["run"]>[1] extends Iterable<infer T> | AsyncIterable<infer T> ? T : never

export interface IngestOptions {
  /** The account the caller means; the envelope's `source.account` must be this one. */
  account: string
  /** Checks and plans everything, then writes nothing. */
  dryRun?: boolean
  /** Records per transaction, 1000 by default. */
  chunk?: number
}

export interface IngestLinesOptions extends IngestOptions {
  /** Every refusal as it happens, also the ones past the receipt's 1000. */
  onIssue?: (issue: IngestError) => void
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
  /**
   * A person, organization or project whose identifiers point at more than one entity: it waits, and the owner says
   * which one it is with `records link`.
   */
  unmatched: { key: string; pointer: string; reason: string; candidates: string[] }[]
  errors: IngestError[]
  /** A list stopped at 1000 entries; the counts are exact. */
  truncated: boolean
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
  unmatched: [],
  errors: [],
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
  waiting: run.waiting.map(({ index, key, missing }) => ({
    key,
    pointer: pointerOf("records", index, "relations"),
    missing,
  })),
  flagged: run.flagged.map(({ index, key, entity }) => ({ key, pointer: pointerOf("records", index), entity })),
  unmatched: run.unmatched.map(({ index, key, reason, candidates }) => ({
    key,
    pointer: pointerOf("records", index, "fields"),
    reason,
    candidates,
  })),
  errors: run.errors,
  truncated: run.truncated,
})

const itemOf = (record: unknown, index: number): RunItem => {
  const errors = recordErrors(record, index)
  return { index, record: record as EnvelopeRecord, ...(errors.length > 0 ? { errors } : {}) }
}

/**
 * Takes a v1 records envelope (or `envelopeOfJsonl` of a JSONL file) into the store: checks it, then writes per
 * chunk in one transaction. The same import twice writes nothing new. A record with a lower revision than the stored
 * one is refused, a delete is soft, a reference to a record not yet imported waits for it, and nothing is linked by
 * name: a person, organization or project is linked by an exact strong identifier, or made. An invoice, a payment
 * and every other record that feeds money totals becomes a proposal: an import never writes confirmed money.
 */
export const ingest = async (
  store: Pick<MessageStore, "records">,
  envelope: unknown,
  { account, dryRun = false, chunk = 1000 }: IngestOptions,
): Promise<IngestReceipt> => {
  const broken = envelopeErrors(envelope, account)
  if (broken.length > 0) return { ...emptyReceipt(dryRun), errors: broken }
  const { source, records, options } = envelope as RecordsEnvelope
  const items = (records as unknown[]).map(itemOf)
  return receiptOf(dryRun, source, await store.records.run(source, items, { dryRun, chunk, options }))
}

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return line
  }
}

/** The lines of a file or of stdin, one at a time, never the whole text. */
export const linesOf = (stream: NodeJS.ReadableStream): AsyncIterable<string> =>
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })

/**
 * `ingest` over a JSONL stream: the first non-empty line is the header (`schema_version`, `source`, `options`), each
 * further non-empty line one record. Records are written per chunk as they arrive, so memory holds one chunk; a dry
 * run is one transaction rolled back at the end, holding the store's write lock until then.
 */
export const ingestLines = async (
  store: Pick<MessageStore, "records">,
  lines: AsyncIterable<string>,
  { account, dryRun = false, chunk = 1000, onIssue }: IngestLinesOptions,
): Promise<IngestReceipt> => {
  const iterator = lines[Symbol.asyncIterator]()
  let header: unknown = {}
  for (let next = await iterator.next(); !next.done; next = await iterator.next())
    if (next.value.trim() !== "") {
      header = parsed(next.value)
      break
    }
  const broken = headerErrors(header, account)
  if (broken.length > 0) {
    for (const error of broken) onIssue?.(error)
    await iterator.return?.()
    return { ...emptyReceipt(dryRun), errors: broken }
  }
  const { source, options } = header as { source: EnvelopeSource; options?: EnvelopeOptions }
  async function* items(): AsyncIterable<RunItem> {
    let index = 0
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      if (next.value.trim() === "") continue
      yield itemOf(parsed(next.value), index)
      index += 1
    }
  }
  return receiptOf(dryRun, source, await store.records.run(source, items(), { dryRun, chunk, options, onIssue }))
}
