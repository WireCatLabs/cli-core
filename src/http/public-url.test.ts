import { describe, expect, it } from "vitest"
import { portOf, publicUrlOf } from "../mcp/index.js"

const context = { missing: "--http", reaches: "the browser apps reach the server" }

describe("public MCP listener options", () => {
  it("accepts a tunnel origin with an explicit HTTPS port and local HTTP for tests", () => {
    expect(publicUrlOf("https://device.example:8443", context).origin).toBe("https://device.example:8443")
    expect(publicUrlOf("http://127.0.0.1:8765", context).origin).toBe("http://127.0.0.1:8765")
    expect(portOf(undefined, 8765)).toBe(8765)
    expect(portOf("8766", 8765)).toBe(8766)
  })
  it.each([
    undefined,
    "no address",
    "https://user@device.example",
    "https://user:synthetic-password@device.example",
    "http://device.example",
    "https://device.example/mcp",
    "https://device.example/?q=x",
    "https://device.example/#x",
  ])("refuses a missing, insecure or non-origin public address: %s", (given) => {
    expect(() => publicUrlOf(given, context)).toThrow()
  })
  it.each(["0", "65536", "1.5", "no port"])("refuses an unusable local port: %s", (given) => {
    expect(() => portOf(given, 8765)).toThrow()
  })
})
