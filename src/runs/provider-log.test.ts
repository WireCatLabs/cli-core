import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openProviderLog, providerWarnings, writeProviderWarning } from "./provider-log.js"

const logIn = () => join(mkdtempSync(join(tmpdir(), "provider-log-")), "provider-log", "personal.jsonl")

describe("provider log", () => {
  it("is private and counts the last day's warnings by kind", () => {
    const path = logIn()
    const now = new Date("2026-11-01T17:00:00Z")
    writeProviderWarning(path, "decrypt", "failed to save identity: database is locked", now)
    writeProviderWarning(path, "decrypt", "failed to save identity: database is locked", now)
    writeProviderWarning(path, "decrypt", "old", new Date("2026-10-30T17:00:00Z"))
    appendFileSync(path, `{"level":"warn","time":"2026-11-01T18:00:44+01:00","message":"zerolog line"}\nnot json\n`)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(providerWarnings(path, new Date("2026-10-31T17:00:00Z"))).toEqual({
      path,
      total: 3,
      kinds: { decrypt: 2, other: 1 },
    })
  })

  it("keeps one older file once the cap is reached, and still counts it", () => {
    const path = logIn()
    openProviderLog(path)
    writeFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), kind: "decrypt", message: "x" })}\n`)
    openProviderLog(path, 10)
    expect(statSync(path).size).toBe(0)
    expect(providerWarnings(path, new Date(0)).total).toBe(1)
  })

  it("answers nothing for a profile that never wrote one", () => {
    const path = logIn()
    expect(providerWarnings(path, new Date(0))).toEqual({ path, total: 0, kinds: {} })
  })
})
