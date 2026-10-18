import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { downloadTextModel } from "./model-downloads.js"

describe("downloadTextModel", () => {
  it("refuses a model with its own terms until they are accepted, before fetching anything", async () => {
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "model-downloads-")) }
    const progress = vi.fn()
    await expect(downloadTextModel("embeddinggemma", { env, progress })).rejects.toThrow("--accept-terms")
    expect(progress).not.toHaveBeenCalled()
  })

  it("names the unknown model", async () => {
    await expect(downloadTextModel("no-such-model", { env: {} })).rejects.toThrow("no-such-model")
  })
})
