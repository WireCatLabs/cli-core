import { afterEach, describe, expect, it } from "vitest"
import { registeredImageProviders, registerImageProvider } from "./registry.js"
import type { ImageProvider } from "./types.js"

const provider = (id: string, version = "1"): ImageProvider => ({ id, version, describe: async () => ({ text: id }) })
const undo: (() => void)[] = []
const add = (one: ImageProvider, options?: { before?: string }) => {
  undo.push(registerImageProvider(one, options))
}
const ids = () => registeredImageProviders().map(({ id }) => id)

afterEach(() => {
  for (const remove of undo.splice(0).reverse()) remove()
})

describe("the image provider registry", () => {
  it("starts with the context provider", () => {
    expect(ids()).toEqual(["context"])
  })

  it("appends a provider, or puts it before another", () => {
    add(provider("picture"))
    add(provider("photo-data"), { before: "picture" })
    expect(ids()).toEqual(["context", "photo-data", "picture"])
  })

  it("replaces a provider with the same id in place, and restores the old one when removed", () => {
    const original = registeredImageProviders()[0]
    add(provider("context", "2"))
    expect(registeredImageProviders()[0]?.version).toBe("2")
    undo.pop()?.()
    expect(registeredImageProviders()).not.toContain(original)
  })

  it("refuses to go before a provider that is not there", () => {
    expect(() => registerImageProvider(provider("a"), { before: "nope" })).toThrow(/no image provider named nope/)
  })
})
