import { describe, expect, it } from "vitest"
import { createOutputBuffer } from "./output-buffer.js"

describe("portable output buffering", () => {
  it("defers complete UTF8 output until flushing without adding delimiters", () => {
    const output: string[] = []
    const buffer = createOutputBuffer({ maxOutputBytes: 7 })
    buffer.data("é\n")
    buffer.data("🙂")
    expect(output).toEqual([])
    expect(buffer.bytes).toBe(7)
    buffer.flush((text) => output.push(text))
    expect(output.join("")).toBe("é\n🙂")
    expect(() => buffer.data("extra")).toThrow(/finished/)
    expect(() => buffer.flush(() => {})).toThrow(/finished/)
  })
  it("rejects an oversized chunk before any emission and allows discarding all buffered output", () => {
    const buffer = createOutputBuffer({ maxOutputBytes: 3 })
    buffer.data("é")
    expect(() => buffer.data("é")).toThrow(
      expect.objectContaining({
        code: "invalid_response",
        details: expect.objectContaining({ reason: "output_limit", bufferedBytes: 2, partialOutput: false }),
      }),
    )
    buffer.discard()
    expect(() => buffer.flush(() => {})).toThrow(/finished/)
    for (const maxOutputBytes of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => createOutputBuffer({ maxOutputBytes })).toThrow(/byte count/)
    const unlimited = createOutputBuffer({ maxOutputBytes: 0 })
    unlimited.data("Example".repeat(100))
    unlimited.discard()
  })
  it("bounds projected JSON bytes while retaining page metadata", () => {
    const buffer = createOutputBuffer({ format: "json", fields: "id", maxOutputBytes: 35 })
    buffer.data(`${JSON.stringify({ items: [{ id: 1, text: "Example".repeat(100) }], page: 2 })}\n`)
    const output: string[] = []
    buffer.flush((text) => output.push(text))
    expect(output).toEqual(['{"items":[{"id":1}],"page":2}\n'])
    expect(buffer.bytes).toBe(Buffer.byteLength(output[0] ?? ""))
  })
  it("projects each complete JSONL line and rejects fragmented JSON before buffering", () => {
    const buffer = createOutputBuffer({ format: "jsonl", fields: "id" })
    buffer.data('{"id":1,"text":"Example"}\n{"id":2,"operationId":"example","text":"Example"}\n')
    buffer.data('{"id":3}')
    const output: string[] = []
    buffer.flush((text) => output.push(text))
    expect(output.join("")).toBe('{"id":1}\n{"id":2,"operationId":"example"}\n{"id":3}')
    for (const format of ["json", "jsonl"] as const) {
      const broken = createOutputBuffer({ format, fields: "id" })
      expect(() => broken.data('{"id":')).toThrow(expect.objectContaining({ code: "invalid_response" }))
      expect(broken.bytes).toBe(0)
      broken.discard()
    }
    for (const format of [undefined, "pretty"] as const)
      expect(() => createOutputBuffer({ format, fields: "id" })).toThrow(/explicit JSON/)
  })
  it("consumes a flush even when the writer throws, avoiding duplicate emission on retry", () => {
    const buffer = createOutputBuffer()
    buffer.data("Example")
    expect(() =>
      buffer.flush(() => {
        throw new Error("Example writer failed")
      }),
    ).toThrow(/writer/)
    expect(() => buffer.flush(() => {})).toThrow(/finished/)
  })
})
