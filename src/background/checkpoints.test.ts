import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  checkpointPath,
  clearCheckpoint,
  progressLine,
  progressOf,
  readCheckpoint,
  saveCheckpoint,
} from "./checkpoints.js"

const state = () => mkdtempSync(join(tmpdir(), "checkpoints-"))

describe("a sync's checkpoint", () => {
  it("keeps the tool's cursor and counts, readable after the process that wrote it is gone", () => {
    const path = checkpointPath(state(), "alice@example.com", "mail")
    saveCheckpoint(
      path,
      { cursor: { validity: 7, uid: 4211 }, done: 120, total: 300 },
      new Date("2026-10-14T10:00:00Z"),
    )

    expect(readCheckpoint(path)).toEqual({
      cursor: { validity: 7, uid: 4211 },
      done: 120,
      total: 300,
      updated_at: "2026-10-14T10:00:00.000Z",
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("starts over rather than failing when the file is torn, and is gone once cleared", () => {
    const path = checkpointPath(state(), "work", "sync")
    saveCheckpoint(path, { cursor: "page-2", done: 1 })
    writeFileSync(path, '{"cursor": "pa')
    expect(readCheckpoint(path)).toBeUndefined()

    saveCheckpoint(path, { cursor: "page-3", done: 2 })
    clearCheckpoint(path)
    expect(readCheckpoint(path)).toBeUndefined()
  })

  it("refuses a name that would leave the checkpoints folder", () => {
    expect(() => checkpointPath(state(), "../work", "mail")).toThrow(/checkpoint is named/)
    expect(() => checkpointPath(state(), "work", "a/b")).toThrow(/checkpoint is named/)
  })
})

describe("a sync's progress", () => {
  it("says what is left and how old the position is, in one shape and one line", () => {
    const progress = progressOf({
      job: "mail",
      profile: "work",
      done: 234_962,
      total: 305_550,
      updatedAt: "2026-10-14T10:00:00.000Z",
      now: new Date("2026-10-14T10:05:00.000Z"),
    })

    expect(progress).toEqual({
      job: "mail",
      profile: "work",
      done: 234_962,
      total: 305_550,
      remaining: 70_588,
      state: "partial",
      updated_at: "2026-10-14T10:00:00.000Z",
      cursor_age_ms: 300_000,
    })
    expect(progressLine(progress)).toBe("mail work: 234,962 of 305,550 (76%), 70,588 left — partial, updated 5m ago")
  })

  it("is complete when the tool says so, even without a total", () => {
    const progress = progressOf({ job: "sync", profile: "work", done: 40, complete: true })
    expect(progress).toMatchObject({ total: null, remaining: null, state: "complete", cursor_age_ms: null })
    expect(progressLine(progress)).toBe("sync work: 40 — complete")
  })
})
