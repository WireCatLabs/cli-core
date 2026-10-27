import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useProviders } from "../domain/providers.js"
import type { TextModel } from "../embeddings/models.js"
import type { EntryInput } from "../meetings/index.js"
import { type MessageStore, openStore } from "../store/store.js"
import { searchEvents } from "./events-search.js"
import { embedEvents } from "./notes-search.js"
import { searchAll } from "./search-all.js"

const tiny: TextModel = {
  id: "e5-small",
  title: "the tiny fixture under the default model's name",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 64,
  chunksPerSecond: 1,
  pooling: "mean",
  prefix: { query: "", passage: "" },
  onnx: "onnx/model.onnx",
  files: [{ name: "onnx/model.onnx", url: "", sha256: "", bytes: 318 }],
}

vi.mock("../embeddings/models.js", async (original) => {
  const real = await original<typeof import("../embeddings/models.js")>()
  return { ...real, textModel: (id: string) => (id === "e5-small" ? tiny : real.textModel(id)), meaningFloor: () => 0 }
})

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 26, 12)
const opened: MessageStore[] = []

let models = ""
beforeEach(() => {
  models = mkdtempSync(join(tmpdir(), "models-"))
  vi.stubEnv("WIRECAT_STATE_DIR", models)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  useProviders([])
  for (const store of opened.splice(0)) await store.close()
})

const download = () => {
  mkdirSync(join(models, "models", "text"), { recursive: true })
  symlinkSync(
    fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
    join(models, "models", "text", "e5-small"),
  )
}

const entry = (externalId: string, title: string, startsAt: number, extra: Partial<EntryInput> = {}): EntryInput => ({
  externalId,
  kind: "single",
  status: "confirmed",
  title,
  startsAt,
  endsAt: startsAt + 3_600_000,
  ...extra,
})

const calendarStore = async (entries: EntryInput[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "events-")), "store.db"), now: () => NOW })
  opened.push(store)
  await store.accounts.registerProvider({ name: "google-calendar", kind: "events", aliases: ["gcal"], command: "gcal" })
  const accountId = await store.accounts.saveAccount(
    { provider: "google-calendar", account: "owner-1" },
    { name: null },
  )
  const [calendar] = await store.calendar.saveCalendars(
    accountId,
    [{ externalId: "primary", title: "Work", timezone: "UTC", accessRole: "owner", primary: true }],
    1,
  )
  await store.calendar.saveEntries(calendar?.id as number, entries, 1)
  return store
}

const weekly = (id: string, title: string, weeks: number) => [
  entry(id, title, NOW, { kind: "series", recurrence: ["RRULE:FREQ=WEEKLY"] }),
  ...Array.from({ length: weeks }, (_, week) =>
    entry(`${id}_${week}`, title, NOW + week * 7 * DAY, {
      kind: "occurrence",
      seriesExternalId: id,
      originalStartsAt: NOW + week * 7 * DAY,
    }),
  ),
]

describe("calendar events by meaning", () => {
  it("embeds a weekly series' one text once and finds it by a word of the same meaning", async () => {
    download()
    const store = await calendarStore([...weekly("s1", "cat", 52), entry("z", "zebra", NOW + DAY)])

    expect(await embedEvents(store, { threads: 1 })).toEqual({ model: "e5-small", embedded: 2, left: false })
    const found = await searchEvents(store, "kitten")

    expect(found.by).toBe("words and meaning")
    expect(found.hits[0]).toMatchObject({ title: "cat", occurrences: 52, found_by: ["meaning"] })
  })

  it("marks a hit found both ways once per series", async () => {
    download()
    const store = await calendarStore(weekly("s1", "cat", 3))
    await embedEvents(store, { threads: 1 })

    const found = await searchEvents(store, "cat")

    expect(found.hits).toHaveLength(1)
    expect(found.hits[0]?.found_by).toEqual(["words", "meaning"])
  })

  it("leaves meaning out, and says why, without the model, for --exact and for a query with fields", async () => {
    const store = await calendarStore([entry("a", "cat", NOW)])
    expect((await searchEvents(store, "cat")).meaning_skipped).toMatch(/not downloaded/)
    download()
    expect((await searchEvents(store, "cat")).meaning_skipped).toMatch(/no event has vectors/)
    await embedEvents(store, { threads: 1 })
    expect((await searchEvents(store, "cat", { exact: true })).meaning_skipped).toMatch(/--exact/)
    expect((await searchEvents(store, "title:cat")).meaning_skipped).toMatch(/fields or operators/)
    expect((await searchEvents(store, "cat")).by).toBe("words and meaning")
  })

  it("never embeds a working-location entry", async () => {
    download()
    const store = await calendarStore([entry("w", "cat", NOW, { eventType: "workingLocation" })])

    expect(await embedEvents(store, { threads: 1 })).toMatchObject({ embedded: 0 })
  })

  it("finds an event through any account holding a searchable copy, not only the first copy's", async () => {
    download()
    const store = await calendarStore([
      entry("busy", "", NOW + DAY, { title: null, visibility: "private", icalUid: "u" }),
    ])
    const other = await store.accounts.saveAccount({ provider: "google-calendar", account: "owner-2" }, { name: null })
    const [calendar] = await store.calendar.saveCalendars(
      other,
      [{ externalId: "primary", title: "Home", timezone: "UTC", accessRole: "owner", primary: true }],
      2,
    )
    await store.calendar.saveEntries(calendar?.id as number, [entry("text", "cat", NOW + DAY, { icalUid: "u" })], 2)
    await embedEvents(store, { threads: 1 })
    const meaning = async (account?: string) =>
      (
        await searchEvents(store, "kitten", account ? { accounts: [{ provider: "google-calendar", account }] } : {})
      ).hits.map(({ title, found_by }) => [title, found_by])

    expect(await meaning()).toEqual([["cat", ["meaning"]]])
    expect(await meaning("owner-2")).toEqual([["cat", ["meaning"]]])
    expect(await meaning("owner-1")).toEqual([])
  })

  it("tells search all how events were searched", async () => {
    download()
    const store = await calendarStore([entry("a", "cat", NOW)])
    await embedEvents(store, { threads: 1 })

    const found = await searchAll(
      store,
      { provider: "telegram", account: "500" },
      {
        text: "kitten",
        limit: 10,
        only: ["events"],
      },
    )

    expect(found.events).toEqual({ by: "words and meaning" })
    expect(found.items.map(({ kind, foundBy }) => [kind, foundBy])).toEqual([["event", ["meaning"]]])
  })
})
