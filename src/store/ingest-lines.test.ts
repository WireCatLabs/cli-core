import { createReadStream, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, expect, it } from "vitest"
import type { IngestError } from "../domain/records.js"
import { ingestLines, linesOf } from "../services/ingest.js"
import { recordsFixture, SOURCE, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const HEADER = JSON.stringify({ schema_version: 1, source: SOURCE })
const shipment = (n: number) => JSON.stringify(upsert("custom:shipment", `s-${n}`, { weight: n }))

it("reads stdin line by line, skips blank lines, and refuses a broken line at its index", async () => {
  const { store } = await recordsFixture(handles)
  const stdin = Readable.from([`\n${HEADER}\r\n`, `${shipment(1)}\n\n`, "not json\n", shipment(2)])
  const issues: IngestError[] = []
  const receipt = await ingestLines(store, linesOf(stdin), {
    account: SOURCE.account,
    onIssue: (one) => issues.push(one),
  })
  expect(receipt).toMatchObject({ created: 2, refused: 1, truncated: false })
  expect(issues).toEqual([expect.objectContaining({ pointer: "/records/1", code: "record.invalid" })])
  expect(await store.records.get({ ...SOURCE, type: "custom:shipment", externalId: "s-2" })).toBeDefined()
})

it("refuses a header that is not one, and an envelope sent as its first line", async () => {
  const { store } = await recordsFixture(handles)
  const whole = JSON.stringify({ schema_version: 1, source: SOURCE, records: [] })
  const receipt = await ingestLines(store, linesOf(Readable.from([whole])), { account: SOURCE.account })
  expect(receipt.errors).toEqual([expect.objectContaining({ pointer: "/records", code: "envelope.invalid" })])
  const other = await ingestLines(store, linesOf(Readable.from([HEADER])), { account: "someone-else" })
  expect(other.errors).toEqual([expect.objectContaining({ code: "envelope.account-mismatch" })])
})

it("streams a file in chunks, and a dry run gives the true receipt across chunks while writing nothing", async () => {
  const { store } = await recordsFixture(handles)
  const path = join(mkdtempSync(join(tmpdir(), "lines-")), "erp.jsonl")
  const records = [
    upsert(
      "invoice",
      "i-1",
      { direction: "receivable", currency: "EUR", lines: [{ description: "x", amount: "5.00" }] },
      {
        relations: [{ role: "counterparty", type: "organization", external_id: "c" }],
      },
    ),
    ...Array.from({ length: 5 }, (_, n) => upsert("custom:filler", `f-${n}`, { n })),
    upsert("organization", "c", { name: "Late client" }),
  ]
  writeFileSync(path, [HEADER, ...records.map((one) => JSON.stringify(one))].join("\n"))
  const options = { account: SOURCE.account, chunk: 2 }
  const dry = await ingestLines(store, linesOf(createReadStream(path)), { ...options, dryRun: true })
  expect(dry).toMatchObject({ dryRun: true, created: 7, waiting: [], proposed: [expect.stringMatching(/^invoice:/)] })
  expect(await store.records.list(SOURCE)).toEqual([])
  expect(await store.finance.invoices()).toEqual([])

  const real = await ingestLines(store, linesOf(createReadStream(path)), options)
  expect(real).toMatchObject({ dryRun: false, created: 7, waiting: [], proposed: dry.proposed })
})

it("keeps the first 1000 entries of a list and says so, while the counts stay exact", async () => {
  const { store } = await recordsFixture(handles)
  const broken = Array.from({ length: 1003 }, () => "{}")
  let told = 0
  const receipt = await ingestLines(store, linesOf(Readable.from([HEADER, ...broken].map((line) => `${line}\n`))), {
    account: SOURCE.account,
    onIssue: () => {
      told += 1
    },
  })
  expect(receipt).toMatchObject({ refused: 1003, truncated: true })
  expect(receipt.errors).toHaveLength(1000)
  expect(told).toBe(1003)
})
