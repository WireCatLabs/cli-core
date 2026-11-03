import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readIcsFile, writeIcsFile } from "./files.js"

const folder = () => mkdtempSync(join(tmpdir(), "calendar-files-"))

describe("the default .ics file reads and writes", () => {
  it("read a file, and name by its path what cannot be read", async () => {
    const dir = folder()
    writeFileSync(join(dir, "a.ics"), "BEGIN:VCALENDAR")
    mkdirSync(join(dir, "sub"))
    expect(await readIcsFile(join(dir, "a.ics"))).toBe("BEGIN:VCALENDAR")
    await expect(readIcsFile(join(dir, "missing.ics"))).rejects.toMatchObject({
      code: "not_found",
      details: { reason: "file.not-found" },
    })
    await expect(readIcsFile(join(dir, "sub"))).rejects.toMatchObject({ details: { reason: "file.not-a-file" } })
  })

  it("write owner-only, into a folder that exists only", async () => {
    const dir = folder()
    const path = join(dir, "out.ics")
    writeFileSync(path, "old", { mode: 0o644 })
    await writeIcsFile(path, "BEGIN:VCALENDAR")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await expect(writeIcsFile(join(dir, "nowhere", "out.ics"), "x")).rejects.toMatchObject({
      details: { reason: "file.not-found" },
    })
  })
})
