import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { kindIn, kindOf, providerNamed, providers, useProviders } from "../../domain/providers.js"
import { openStore, registerProvider } from "../store.js"
import { openSqlite } from "./open.js"

const pathOf = () => join(mkdtempSync(join(tmpdir(), "providers-")), "m.db")
const calendar = { name: "example-calendar", kind: "events", aliases: ["exc"], command: "excal" } as const

afterEach(() => useProviders([]))

describe("the stored provider registry", () => {
  it("**loads an entry another handle stored** when the store opens", async () => {
    const path = pathOf()
    const writer = await openStore({ path })
    await registerProvider(writer, calendar)
    await writer.close()
    useProviders([])
    expect(providerNamed("exc")).toBeUndefined()

    const reader = await openStore({ path, readOnly: true })
    expect(providerNamed("EXC")?.name).toBe("example-calendar")
    expect(kindIn("example-calendar")).toBe("events")
    await reader.close()

    await (await openStore({ path: pathOf() })).close()
    expect(kindIn("example-calendar")).toBeUndefined()
    expect(kindOf("example-calendar")).toBe("messages")
  })

  it("writes an entry only when it changed, and keeps one entry per name", async () => {
    const path = pathOf()
    const stored = () => {
      const database = new DatabaseSync(path, { readOnly: true })
      const row = database.prepare("SELECT value, at FROM store_settings WHERE key = 'providers'").get() as {
        value: string
        at: number
      }
      database.close()
      return { at: row.at, entries: JSON.parse(row.value) }
    }
    let now = 1
    const store = await openStore({ path, now: () => now })
    await registerProvider(store, calendar)
    now = 2
    await registerProvider(store, calendar)
    expect(stored().at).toBe(1)
    now = 3
    await registerProvider(store, { ...calendar, aliases: ["exc", "ec"] })
    expect(stored()).toEqual({ at: 3, entries: [{ ...calendar, aliases: ["exc", "ec"] }] })
    await store.close()
  })

  it("**refuses two entries that disagree on a kind**, naming both, and an alias of another provider", async () => {
    const store = await openStore({ path: pathOf() })
    await expect(registerProvider(store, { name: "zoom", kind: "events", aliases: [], command: "zm" })).rejects.toThrow(
      "two provider entries disagree on the kind: zoom (meetings) and zoom (events, from zm)",
    )
    await expect(registerProvider(store, { ...calendar, aliases: ["tg"] })).rejects.toThrow(
      '"tg" names two providers: telegram (messages, from tg) and example-calendar (events, from excal)',
    )
    expect(() => useProviders([calendar, { ...calendar, kind: "notes" }])).toThrow("disagree on the kind")
    expect(providerNamed("exc")).toBeUndefined()
    await store.close()
  })

  it("lets a CLI add its aliases and command to a built-in of the same kind", async () => {
    const store = await openStore({ path: pathOf() })
    await registerProvider(store, { name: "zoom", kind: "meetings", aliases: ["zm"], command: "zm" })
    expect(providerNamed("zm")).toEqual({ name: "zoom", kind: "meetings", aliases: ["zm"], command: "zm" })
    await store.close()
  })

  it("opens a store whose stored entries clash or are unreadable, leaving those out", async () => {
    const path = pathOf()
    await (await openStore({ path })).close()
    const { database } = await openSqlite(path)
    database
      .prepare("INSERT INTO store_settings (key, value, at) VALUES ('providers', ?, 1)")
      .run(JSON.stringify([{ name: "zoom", kind: "notes", aliases: [] }, { name: "x", kind: "later" }, calendar]))
    database.close()

    const store = await openStore({ path })
    expect(kindIn("zoom")).toBe("meetings")
    expect(kindIn("x")).toBeUndefined()
    expect(kindIn("example-calendar")).toBe("events")
    await registerProvider(store, { name: "drive", kind: "documents", aliases: [], command: "drive" })
    await store.close()

    const { database: after } = await openSqlite(path)
    const row = after.prepare("SELECT value FROM store_settings WHERE key = 'providers'").get() as { value: string }
    after.close()
    expect(JSON.parse(row.value).map(({ name }: { name: string }) => name)).toEqual([
      "zoom",
      "x",
      "example-calendar",
      "drive",
    ])
    expect(providers().map(({ name }) => name)).toContain("drive")
  })
})
