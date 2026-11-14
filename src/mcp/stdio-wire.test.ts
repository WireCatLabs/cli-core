import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { answeredWire } from "./stdio-wire.js"

const settled = async (promise: Promise<void>) => {
  let done = false
  promise.then(() => {
    done = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  return done
}

const wireOf = () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const wire = answeredWire(stdin, stdout)
  wire.input.resume()
  const send = (message: object) => stdin.write(`${JSON.stringify(message)}\n`)
  const answer = (id: number) => wire.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`)
  return { stdin, wire, send, answer }
}

describe("the stdio wire", () => {
  it("waits for what was asked after stdin ends, and no longer", async () => {
    const { stdin, wire, send, answer } = wireOf()
    send({ jsonrpc: "2.0", id: 1, method: "tools/call" })
    stdin.end()
    const finished = wire.finished(new AbortController().signal)
    expect(await settled(finished)).toBe(false)
    answer(1)
    expect(await settled(finished)).toBe(true)
  })

  it("does not wait for a request the client cancelled, nor for a line that is not JSON-RPC 2.0", async () => {
    const { stdin, wire, send } = wireOf()
    send({ jsonrpc: "2.0", id: 5, method: "tools/call" })
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } })
    send({ id: 6, method: "tools/list" })
    stdin.end()
    expect(await settled(wire.finished(new AbortController().signal))).toBe(true)
  })

  it("stops on its signal while a call is still open", async () => {
    const { stdin, wire, send } = wireOf()
    const stop = new AbortController()
    send({ jsonrpc: "2.0", id: 1, method: "tools/call" })
    stdin.end()
    const finished = wire.finished(stop.signal)
    stop.abort()
    expect(await settled(finished)).toBe(true)
  })
})
