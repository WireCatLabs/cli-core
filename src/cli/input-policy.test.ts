import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { bufferedInput, inputPolicy, provideInputPolicy } from "./input-policy.js"

describe("buffered input policy", () => {
  it("counts UTF-8 bytes and rejects before retaining excess input", async () => {
    const input = Readable.from(["ab", "😀"])
    const release = provideInputPolicy(input, { maxBytes: 5 })
    await expect(bufferedInput(input)).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "input.too-large" },
    })
    expect(input.listenerCount("data")).toBe(0)
    release()
    expect(inputPolicy(input)).toEqual({})
  })
  it("returns complete input at the exact limit", async () => {
    expect((await bufferedInput(Readable.from(["ab", "cd"]), { maxBytes: 4 })).toString()).toBe("abcd")
  })
  it("cancels an open pipe and releases its listeners", async () => {
    const input = new Readable({ read() {} })
    const stop = new AbortController()
    const result = bufferedInput(input, { signal: stop.signal })
    stop.abort()
    await expect(result).rejects.toMatchObject({ code: "cancelled" })
    expect(input.listenerCount("data")).toBe(0)
    expect(input.listenerCount("end")).toBe(0)
    input.destroy()
  })
  it("restores a previous policy and handles an already-cancelled read", async () => {
    const input = Readable.from([])
    const first = provideInputPolicy(input, { maxBytes: 10 })
    const stop = new AbortController()
    stop.abort()
    const second = provideInputPolicy(input, { signal: stop.signal })
    await expect(bufferedInput(input)).rejects.toMatchObject({ code: "cancelled" })
    second()
    expect(inputPolicy(input)).toEqual({ maxBytes: 10 })
    first()
  })
  it("reports a closed pipe and propagates input errors", async () => {
    for (const event of ["close", "error"] as const) {
      const input = new Readable({ read() {} })
      const result = bufferedInput(input)
      if (event === "close") input.emit("close")
      else input.emit("error", new Error("synthetic IO failure"))
      await expect(result).rejects.toThrow(event === "close" ? "before EOF" : "synthetic IO failure")
      input.destroy()
    }
  })
})
