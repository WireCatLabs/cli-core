import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import { expect, it } from "vitest"
import { validateAst } from "../search/lucene/registry.js"
import { searchRecordOf } from "../services/searches.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const QUERY = 'date:[2026-01-01 TO 2026-02-01} -kind:bot (счёт OR "say \\"mustNot\\":")'

const camelCase = (json: string) =>
  json
    .replaceAll('"lower_inclusive":', '"lowerInclusive":')
    .replaceAll('"upper_inclusive":', '"upperInclusive":')
    .replaceAll('"occur":"must_not"', '"occur":"mustNot"')

it("rewrites the query trees of saved searches, rankings and runs stored before version 6, and nothing else", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-6-")), "wirecat.db")
  await (await openStore({ path })).close()

  const tree = parseLucene(QUERY)
  const after = searchRecordOf("search", { ast: tree, timezone: "UTC" })
  const before = { ...after, params: camelCase(after.params) }
  const ranked = searchRecordOf("message-top", { selection: { execution: { root: tree.root } }, measure: "count" })
  const selection = { ...ranked, params: camelCase(ranked.params) }
  const text = searchRecordOf("search", { text: QUERY })
  expect(before.params).toContain('"lowerInclusive":true')
  expect(selection.params).toContain('"occur":"mustNot"')

  const old = await openCache(path)
  const insert = old.prepare(
    `INSERT INTO searches (name, command, params, language, version, fields_version, created_at, updated_at, last_run_at, runs)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`,
  )
  for (const [name, record] of [
    ["invoices", before],
    [null, before],
    ["top", selection],
    ["words", text],
  ] as const)
    insert.run(name, record.command, record.params, record.language, record.version, record.fieldsVersion)
  rollBackTo(old, 6)
  old.close()

  const upgraded = await openStore({ path })
  try {
    const saved = await upgraded.storedSearch("invoices")
    expect(saved && JSON.stringify(saved.params)).toBe(after.params)
    expect(validateAst(saved?.params.ast)).toEqual(tree)
    expect(JSON.stringify((await upgraded.storedSearch("top"))?.params)).toBe(ranked.params)
    expect(JSON.stringify((await upgraded.storedSearch("words"))?.params)).toBe(text.params)

    await upgraded.recordSearch(after)
    const runs = (await upgraded.searchHistory(10)).filter((one) => one.name === null)
    expect(runs.map((one) => one.runs)).toEqual([2])
  } finally {
    await upgraded.close()
  }
})
