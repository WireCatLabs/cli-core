import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene, validateQuery } from "@wirecat/cli-base/query"
import { expect, it } from "vitest"
import { EVENT_QUERY } from "../meetings/index.js"
import { sampleEvent } from "../meetings/testing/index.js"
import { openStore } from "./store.js"

it("filters event ids, origins and time ranges inside the SQLite store", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "event-query-")), "fixture.db") })
  try {
    const first = await store.meetings.createEvent(
      { ...sampleEvent(), origin: "auto", startsAt: Date.parse("2026-01-01T10:00:00Z") },
      1,
    )
    const second = await store.meetings.createEvent(
      { ...sampleEvent(), origin: "owner", startsAt: Date.parse("2026-10-01T10:00:00Z") },
      2,
    )
    const read = async (text: string) => {
      const query = parseLucene(text, { defaultField: "none" })
      validateQuery(query, EVENT_QUERY)
      if (!store.meetings.queryEvents) throw new Error("native event queries are missing")
      return (await store.meetings.queryEvents(query)).map((event) => event.id)
    }
    expect(await read("origin:owner")).toEqual([second.id])
    expect(await read(`id:${first.id}`)).toEqual([first.id])
    expect(await read("starts_at>=2026-09-01")).toEqual([second.id])
    expect(await read(`origin:owner id:${first.id}`)).toEqual([])
    expect(await read(`origin:owner OR id:${first.id}`)).toEqual([first.id, second.id])
    await expect(read("not_a_field:value")).rejects.toThrow()
  } finally {
    await store.close()
  }
})
