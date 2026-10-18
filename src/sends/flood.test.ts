import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FloodMemory, FROZEN_HOLD_MS, floodPathFor, LIMITED_HOLD_MS } from "./flood.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0" }
const at = (iso: string) => () => Date.parse(iso)
const memoryAt = (iso: string, path = join(mkdtempSync(join(tmpdir(), "flood-")), "flood", "p.json")) =>
  new FloodMemory(path, at(iso))

describe("flood memory", () => {
  it("lives in the state folder, one file per profile", () => {
    expect(floodPathFor(app, "work", { APP_STATE_DIR: "/state" })).toBe("/state/flood/work.json")
  })

  it("**remembers a wait across instances, owner-only, and forgets it once it has passed**", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.remember({ operation: "history", waitMs: 60_000, providerError: "FLOOD_WAIT" })

    const later = new FloodMemory(memory.path, at("2026-10-04T10:00:59Z"))
    expect(later.owed("history", "42")).toEqual({
      operation: "history",
      until: "2026-10-04T10:01:00.000Z",
      providerError: "FLOOD_WAIT",
    })
    expect(new FloodMemory(memory.path, at("2026-10-04T10:01:00Z")).owed("history")).toBeUndefined()
    expect(statSync(memory.path).mode & 0o777).toBe(0o600)
  })

  it("a wait said about one chat holds only that chat; one said about the call holds every chat", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.remember({ operation: "send", chatId: "1", waitMs: 30_000 })

    expect(memory.owed("send", "1")).toBeDefined()
    expect(memory.owed("send", "2")).toBeUndefined()
    expect(memory.owed("history", "1")).toBeUndefined()
  })

  it("keeps at most 50, dropping the ones that end soonest", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    for (let i = 1; i <= 55; i += 1) memory.remember({ operation: `op${i}`, waitMs: i * 1000 })

    const { deadlines } = memory.read()
    expect(deadlines).toHaveLength(50)
    expect(deadlines.map((one) => one.operation)).not.toContain("op5")
    expect(deadlines.map((one) => one.operation)).toContain("op6")
  })

  it("reads a torn or foreign file as empty rather than failing a command", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.remember({ operation: "history", waitMs: 1000 })
    writeFileSync(memory.path, "{not json")

    expect(memory.read()).toEqual({ deadlines: [] })
  })

  it("**holds a spam limit an hour and a frozen account a day** when the messenger gave no end", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    const frozen = memory.block({ state: "frozen", hint: "frozen" })
    expect(Date.parse(frozen.until ?? "") - Date.parse(frozen.since)).toBe(FROZEN_HOLD_MS)
    const block = memory.block({ state: "limited", hint: "spam" })
    expect(Date.parse(block.until ?? "") - Date.parse(block.since)).toBe(LIMITED_HOLD_MS)
    expect(LIMITED_HOLD_MS).toBe(60 * 60 * 1000)
  })

  it("**holds a ban with no end until it is lifted**, however long that takes", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    expect(memory.block({ state: "banned", hint: "banned" })).toMatchObject({ state: "banned", until: null })

    const yearsLater = memoryAt("2030-01-01T00:00:00Z", memory.path)
    expect(yearsLater.sendBlock()).toMatchObject({ state: "banned", until: null })
    yearsLater.unblock("banned")
    expect(yearsLater.sendBlock()).toBeUndefined()
  })

  it("a ban the messenger gave an end for ends then", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.block({ state: "banned", hint: "banned", until: "2026-10-05T10:00:00Z" })

    expect(memoryAt("2026-10-05T09:59:00Z", memory.path).sendBlock()).toBeDefined()
    expect(memoryAt("2026-10-05T10:00:00Z", memory.path).sendBlock()).toBeUndefined()
  })

  it("a new refusal sets the hour again", () => {
    const path = join(mkdtempSync(join(tmpdir(), "flood-")), "p.json")
    memoryAt("2026-10-04T10:00:00Z", path).block({ state: "limited", hint: "spam" })
    const again = memoryAt("2026-10-04T10:50:00Z", path).block({ state: "limited", hint: "spam" })

    expect(again.until).toBe("2026-10-04T11:50:00.000Z")
    expect(memoryAt("2026-10-04T11:10:00Z", path).sendBlock()).toBeDefined()
  })

  it("clear forgets every wait and the hold, and says what was in force", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.remember({ operation: "history", waitMs: 60_000 })
    memory.block({ state: "limited", hint: "spam" })

    expect(memory.clear()).toMatchObject({ deadlines: [{ operation: "history" }], sendBlock: { state: "limited" } })
    expect(memory.read()).toEqual({ deadlines: [] })
    expect(memory.clear()).toEqual({ deadlines: [] })
  })

  it("lifting a frozen hold leaves a spam limit alone", () => {
    const memory = memoryAt("2026-10-04T10:00:00Z")
    memory.block({ state: "limited", hint: "spam" })

    memory.unblock("frozen")
    expect(memory.sendBlock()).toMatchObject({ state: "limited" })
    memory.unblock("limited")
    expect(memory.sendBlock()).toBeUndefined()

    memory.block({ state: "frozen", hint: "frozen", until: "2026-10-04T09:00:00Z" })
    expect(memory.sendBlock()).toBeUndefined()
  })
})
