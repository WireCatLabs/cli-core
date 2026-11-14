import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { sharedModelsDirectory } from "../speech/install.js"

describe("the test sandbox", () => {
  it("keeps the default model folder inside it when a test passes an env without overrides", () => {
    expect(sharedModelsDirectory("text", {}).startsWith(String(process.env.TMPDIR))).toBe(true)
  })

  // A folder made at a fixed path such as /var/tmp is outside the sandbox and outlives the run: ~19k of them filled
  // the disk on 2026-11-14.
  it("is where every test makes its temporary folders", () => {
    const src = join(import.meta.dirname, "..")
    const fixed = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(test\.)?ts$/.test(file))
      .filter((file) => /mkdtemp(Sync)?\(\s*["'`]\//.test(readFileSync(join(src, file), "utf8")))
    expect(fixed).toEqual([])
  })
})
