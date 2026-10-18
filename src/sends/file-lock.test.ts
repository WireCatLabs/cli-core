import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withFileLockAsync } from "./file-lock.js"

const heldPath = () => {
  const path = join(mkdtempSync(join(tmpdir(), "file-lock-")), "journal.jsonl")
  writeFileSync(`${path}.lock`, "")
  return path
}

describe("the async file lock", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps the event loop running while another process holds the lock, then refuses after 5 s", async () => {
    const path = heldPath()
    const body = vi.fn()
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 100)
    const waiting = withFileLockAsync(path, "the send journal", body)
    const refused = expect(waiting).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("the send journal stayed locked for 5s"),
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(ticked).toBe(true)
    expect(body).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    await refused
    expect(body).not.toHaveBeenCalled()
    expect(existsSync(`${path}.lock`)).toBe(true)
  })

  it("runs the body once the holder lets go, and releases the lock after it", async () => {
    const path = heldPath()
    const waiting = withFileLockAsync(path, "the request pace", () => "done")

    await vi.advanceTimersByTimeAsync(200)
    unlinkSync(`${path}.lock`)
    await vi.advanceTimersByTimeAsync(20)

    await expect(waiting).resolves.toBe("done")
    expect(existsSync(`${path}.lock`)).toBe(false)
  })
})
