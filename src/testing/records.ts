import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { EnvelopeRecord } from "../domain/records.js"
import { ingest } from "../services/ingest.js"
import { openStore } from "../store/store.js"

export type TestStore = Awaited<ReturnType<typeof openStore>>

export const SOURCE = { provider: "sheet", account: "demo-rent", batch_id: "2026-11-02" }

/** A synthetic store in a temp folder, a clock that moves one ms per read, and raw SQL beside it for checks. */
export const recordsFixture = async (handles: { close(): unknown }[]) => {
  let clock = Date.UTC(2026, 10, 2)
  const path = join(mkdtempSync(join(tmpdir(), "records-")), "store.db")
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const sql = () => {
    const database = new DatabaseSync(path)
    handles.push(database)
    return database
  }
  return { store, path, sql }
}

export const envelopeOf = (
  records: unknown[],
  {
    batch = SOURCE.batch_id,
    account = SOURCE.account,
    provider = SOURCE.provider,
    options = undefined as unknown,
  } = {},
) => ({
  schema_version: 1,
  source: { provider, account, batch_id: batch },
  ...(options === undefined ? {} : { options }),
  records,
})

export const take = (store: TestStore, value: unknown, { dryRun = false, account = SOURCE.account } = {}) =>
  ingest(store, value, { account, dryRun })

export const upsert = (
  type: string,
  externalId: string,
  fields: Record<string, unknown>,
  extra: Partial<EnvelopeRecord> = {},
): EnvelopeRecord => ({
  key: `${type}-${externalId}`,
  type,
  external_id: externalId,
  operation: "upsert",
  fields,
  ...extra,
})
