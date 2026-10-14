import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { writeProgress } from "./download-command.js"
import { type ExportManifest, saveManifest } from "./export-folder.js"

// --output and --output-dir may be folders somebody else can write to (FIND-1299).
const plant = () => {
  const dir = mkdtempSync(join(tmpdir(), "temporary-writes-"))
  const victim = join(mkdtempSync(join(tmpdir(), "victim-")), "victim.txt")
  writeFileSync(victim, "untouched")
  return { dir, victim }
}

describe.skipIf(process.platform === "win32")("a file replaced in an output folder", () => {
  it("**never writes through a link planted at the old temporary name** — download progress", () => {
    const { dir, victim } = plant()
    const path = join(dir, ".download-42.json")
    symlinkSync(victim, `${path}.tmp`)

    writeProgress(path, "42", { by: "id", done: [] })

    expect(readFileSync(victim, "utf8")).toBe("untouched")
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ chat: "42", by: "id", done: [] })
    expect(readdirSync(dir).sort()).toEqual([".download-42.json", ".download-42.json.tmp"])
  })

  it("**never writes through a link planted at the old temporary name** — the export manifest", () => {
    const { dir, victim } = plant()
    symlinkSync(victim, join(dir, ".manifest.json.next"))
    const manifest = { format: "wirecat-export", version: 1, provider: "chat", account: "1", chats: {} }

    saveManifest(dir, manifest as unknown as ExportManifest)

    expect(readFileSync(victim, "utf8")).toBe("untouched")
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toEqual(manifest)
    expect(readdirSync(dir).sort()).toEqual([".manifest.json.next", "manifest.json"])
  })
})
