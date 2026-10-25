import { expect, it, vi } from "vitest"
import { loadVectorExtension, vectorExtension } from "./vector-extension.js"

vi.mock("@wirecat/cli-core-sqlite", () => ({ extensionFor: () => undefined }))

it("refuses to open a store without the extension, naming the platform and the fix", async () => {
  await expect(vectorExtension()).rejects.toMatchObject({
    code: "configuration_error",
    message: expect.stringContaining(`for ${process.platform}-${process.arch}`),
  })
})

it("reports an extension that does not load, and closes SQL's load_extension() either way", () => {
  const enableLoadExtension = vi.fn()
  const database = {
    loadExtension: () => {
      throw new Error("invalid ELF header")
    },
    enableLoadExtension,
  }
  expect(() => loadVectorExtension(database, "/nowhere/vec0.so")).toThrow(/sqlite-vec extension did not load/)
  expect(enableLoadExtension).toHaveBeenCalledWith(false)
})
