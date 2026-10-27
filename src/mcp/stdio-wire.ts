import { PassThrough, type Readable, Writable } from "node:stream"

type JsonRpc = { id?: unknown; method?: unknown }

const lineReader = (onMessage: (message: JsonRpc) => void) => {
  let rest = ""
  return (chunk: Buffer | string) => {
    const lines = (rest + chunk.toString()).split("\n")
    rest = lines.pop() ?? ""
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as JsonRpc
        if (message !== null && typeof message === "object") onMessage(message)
      } catch {
        // Not a message; the transport answers it as a parse error.
      }
    }
  }
}

/**
 * Stdin and stdout as the transport sees them, noting each request that comes in and each answer that goes out, so
 * the server can tell when everything asked has been answered. The transport's stdin never ends by itself: the server
 * closes it, after the client's stdin ended and the last answer went out.
 */
export const answeredWire = (source: Readable, sink: Writable) => {
  const asked = new Set<string>()
  let settle: (() => void) | undefined
  const input = new PassThrough()
  const onData = lineReader(({ id, method }) => {
    if (id !== undefined && typeof method === "string") asked.add(JSON.stringify(id))
  })
  const output = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      noteAnswer(chunk)
      sink.write(chunk, done)
    },
  })
  const noteAnswer = lineReader(({ id, method }) => {
    if (id === undefined || method !== undefined) return
    asked.delete(JSON.stringify(id))
    if (asked.size === 0) settle?.()
  })
  const forward = (chunk: Buffer) => {
    onData(chunk)
    input.write(chunk)
  }
  source.on("data", forward)
  const ended = new Promise<void>((resolve) => {
    source.once("end", resolve)
    source.once("close", resolve)
  })
  return {
    input,
    output,
    ended,
    answered: () =>
      new Promise<void>((resolve) => {
        if (asked.size === 0) resolve()
        else settle = resolve
      }),
    /** Lets go of the real stdin, so it no longer holds the process open. */
    release: () => {
      source.off("data", forward)
      if (source.listenerCount("data") === 0) source.pause()
      input.end()
    },
  }
}
