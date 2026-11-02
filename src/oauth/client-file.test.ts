import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readClientFile } from "./client-file.js"

const fileWith = (content: string, mode = 0o600) => {
  const file = join(mkdtempSync(join(tmpdir(), "client-file-")), "client.json")
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}
const desktop = JSON.stringify({ installed: { client_id: "id.apps.googleusercontent.com", client_secret: "s3cret" } })

describe("readClientFile", () => {
  it("reads a Desktop client with and without a secret", () => {
    expect(readClientFile(fileWith(desktop))).toEqual({
      clientId: "id.apps.googleusercontent.com",
      clientSecret: "s3cret",
    })
    expect(readClientFile(fileWith(JSON.stringify({ installed: { client_id: "x" } })))).toEqual({ clientId: "x" })
  })

  it.skipIf(process.platform === "win32")("refuses a file other users can read", () => {
    expect(() => readClientFile(fileWith(desktop, 0o644))).toThrow(/chmod 600/)
    expect(readClientFile(fileWith(desktop, 0o644), { shipped: true }).clientId).toBe("id.apps.googleusercontent.com")
  })

  it("refuses a wrong shape without printing the contents", () => {
    for (const content of [
      "not json",
      JSON.stringify({ web: { client_id: "x" } }),
      JSON.stringify({ installed: { client_id: "" } }),
    ]) {
      const error = (() => {
        try {
          readClientFile(fileWith(content))
        } catch (caught) {
          return caught as Error
        }
      })()
      expect(error?.message).toContain("could not read a Desktop app OAuth client JSON")
      expect(error?.message).not.toContain(content)
    }
  })
})
